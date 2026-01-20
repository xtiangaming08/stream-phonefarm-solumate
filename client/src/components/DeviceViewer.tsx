import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useActive } from '@/context/ActiveContext';
import { useServer } from '@/context/ServerContext';
import { attachTouchControls } from '@/lib/touchControls';
import type { FileStats } from '@/lib/serverApi';
import { encodeKeycodeMessage, KeyEventAction } from '@/lib/control';
import { AndroidKeycode } from '@/lib/keyEvent';
import { ShellPage } from '@/pages/ShellPage';
import {
  ArrowLeft,
  Camera,
  Download,
  FileText,
  Folder,
  Home,
  Menu,
  Power,
  RefreshCw,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

type Props = {
  udid: string;
  onClose: () => void;
  wsServer: string;
};

type ViewerTab = 'view' | 'files' | 'apps' | 'shell';

function normPath(p: string): string {
  let out = (p || '/').trim().replace(/\\/g, '/');
  out = out.replace(/\/+/g, '/');
  if (!out.startsWith('/')) out = '/' + out;
  return out;
}

function joinPath(base: string, name: string): string {
  const b = normPath(base);
  const n = String(name || '').replace(/^\/+/, '');
  if (b.endsWith('/')) return b + n;
  return b + '/' + n;
}

function parentPath(p: string): string {
  const x = normPath(p);
  if (x === '/' || x === '') return '/';
  const noTrail = x.endsWith('/') ? x.slice(0, -1) : x;
  const idx = noTrail.lastIndexOf('/');
  if (idx <= 0) return '/';
  return noTrail.slice(0, idx + 1);
}

function isTextFile(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.endsWith('.txt') ||
    n.endsWith('.log') ||
    n.endsWith('.json') ||
    n.endsWith('.xml') ||
    n.endsWith('.csv') ||
    n.endsWith('.md') ||
    n.endsWith('.ini') ||
    n.endsWith('.yaml') ||
    n.endsWith('.yml') ||
    n.endsWith('.js') ||
    n.endsWith('.ts') ||
    n.endsWith('.html') ||
    n.endsWith('.css')
  );
}

function isImageFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.webp') || n.endsWith('.gif');
}

type PreviewState =
  | { kind: 'none' }
  | { kind: 'text'; path: string; text: string }
  | { kind: 'image'; path: string; url: string }
  | { kind: 'blob'; path: string; url: string };

/**
 * Right-side "Open device" viewer:
 * - Mirrors the decoded canvas from the tile (no extra WS/decoder)
 * - Fixes aspect ratio (no stretch)
 * - Adds per-device Files + Apps panels
 */
const DeviceViewerComponent = ({ udid, onClose, wsServer }: Props) => {
  const { listDir, pullFile, pushFile } = useServer();
  const { getCanvasForUdid, getInputTargetsForSource, selectOnly } = useActive();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const rafRef = useRef<number | null>(null);

  const [status, setStatus] = useState<'connecting' | 'ready'>('connecting');
  const [tab, setTab] = useState<ViewerTab>('view');

  const viewerAspectRef = useRef<number>(9 / 16);
  const [viewerAspect, setViewerAspect] = useState<number>(9 / 16);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const sendKeyToThis = (keycode: number) => {
    const targets = getInputTargetsForSource(udid);
    const down = encodeKeycodeMessage(KeyEventAction.DOWN, keycode);
    const up = encodeKeycodeMessage(KeyEventAction.UP, keycode);
    for (const t of targets) {
      try {
        t.ws.send(down);
        t.ws.send(up);
      } catch {
        // ignore
      }
    }
  };

  const takeScreenshot = () => {
    const src = getCanvasForUdid(udid);
    if (!src) return;
    try {
      const a = document.createElement('a');
      a.download = `${udid}_${Date.now()}.png`;
      a.href = src.toDataURL('image/png');
      a.click();
    } catch {
      // ignore
    }
  };

  // ===== Touch controls: only bind when we are in "view" tab.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    detachRef.current?.();
    detachRef.current = null;

    if (tab !== 'view') return;

    const onActivate = () => selectOnly(udid);
    detachRef.current = attachTouchControls(c, () => getInputTargetsForSource(udid), onActivate);

    return () => {
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [udid, tab, getInputTargetsForSource, selectOnly]);

  // ===== Mirror tile canvas into viewer canvas (RAF), only in view tab.
  useEffect(() => {
    if (tab !== 'view') return;
    const dst = canvasRef.current;
    if (!dst) return;
    const ctx = dst.getContext('2d', { alpha: false });
    if (!ctx) return;

    const tick = () => {
      const src = getCanvasForUdid(udid);
      if (src && src.width > 0 && src.height > 0) {
        if (dst.width !== src.width || dst.height !== src.height) {
          dst.width = src.width;
          dst.height = src.height;
        }
        const ratio = src.width / src.height;
        if (Number.isFinite(ratio) && Math.abs(ratio - viewerAspectRef.current) > 0.001) {
          viewerAspectRef.current = ratio;
          setViewerAspect(ratio);
        }
        try {
          ctx.drawImage(src, 0, 0, dst.width, dst.height);
          if (status !== 'ready') setStatus('ready');
        } catch {
          // ignore
        }
      } else {
        if (status !== 'connecting') setStatus('connecting');
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [udid, tab, getCanvasForUdid]);

  // ===== Files tab state =====
  const [cwd, setCwd] = useState<string>(() => {
    try {
      return localStorage.getItem('viewerCwd') || '/sdcard/';
    } catch {
      return '/sdcard/';
    }
  });
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [entries, setEntries] = useState<(FileStats & { fullPath: string; isDirBool: boolean })[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'none' });
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const parent = useMemo(() => parentPath(cwd), [cwd]);

  useEffect(() => {
    try {
      localStorage.setItem('viewerCwd', cwd);
    } catch {}
  }, [cwd]);

  // Revoke preview URLs on change/unmount
  useEffect(() => {
    return () => {
      if (preview.kind === 'image' || preview.kind === 'blob') {
        try {
          URL.revokeObjectURL(preview.url);
        } catch {}
      }
    };
  }, [preview]);

  const refreshDir = async (path?: string) => {
    const p = normPath(path ?? cwd);
    setFileLoading(true);
    setFileError(null);
    try {
      const list = await listDir(udid, p);
      const mapped = list
        .filter((x) => x && typeof x.name === 'string')
        .map((x) => ({
          ...x,
          fullPath: joinPath(p, x.name),
          isDirBool: x.isDir === 1,
        }))
        .sort((a, b) => {
          if (a.isDirBool !== b.isDirBool) return a.isDirBool ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      setEntries(mapped);
      setCwd(p);
    } catch (e: any) {
      setEntries([]);
      setFileError(String(e?.message || e || 'List failed'));
    } finally {
      setFileLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== 'files') return;
    refreshDir();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, udid]);

  const openFile = async (fullPath: string, name: string) => {
    // Clear old preview first
    setPreview((prev) => {
      if (prev.kind === 'image' || prev.kind === 'blob') {
        try {
          URL.revokeObjectURL(prev.url);
        } catch {}
      }
      return { kind: 'none' };
    });

    setFileLoading(true);
    setFileError(null);
    try {
      const blob = await pullFile(udid, fullPath);
      if (isImageFile(name)) {
        const url = URL.createObjectURL(blob);
        setPreview({ kind: 'image', path: fullPath, url });
      } else if (isTextFile(name) && blob.size <= 2_000_000) {
        const text = await blob.text();
        setPreview({ kind: 'text', path: fullPath, text });
      } else {
        const url = URL.createObjectURL(blob);
        setPreview({ kind: 'blob', path: fullPath, url });
      }
    } catch (e: any) {
      setFileError(String(e?.message || e || 'Open file failed'));
    } finally {
      setFileLoading(false);
    }
  };

  const downloadCurrentPreview = () => {
    if (preview.kind !== 'image' && preview.kind !== 'blob') return;
    const a = document.createElement('a');
    a.href = preview.url;
    a.download = preview.path.split('/').pop() || 'download';
    a.click();
  };

  const onUploadPick = async (f: File | null) => {
    if (!f) return;
    setFileLoading(true);
    setFileError(null);
    try {
      const dst = joinPath(cwd, f.name);
      await pushFile(udid, f, dst);
      await refreshDir(cwd);
    } catch (e: any) {
      setFileError(String(e?.message || e || 'Upload failed'));
    } finally {
      setFileLoading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  // ===== Apps tab (best-effort) =====
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [apps, setApps] = useState<{ name: string; path: string }[]>([]);
  const [appsFilter, setAppsFilter] = useState('');
  const shellWrapRef = useRef<HTMLDivElement | null>(null);

  const appRoots = useMemo(
    () => ['/system/app/', '/system/priv-app/', '/product/app/', '/vendor/app/', '/data/app/'],
    [],
  );

  const refreshApps = async () => {
    setAppsLoading(true);
    setAppsError(null);
    const out: { name: string; path: string }[] = [];
    try {
      for (const root of appRoots) {
        try {
          const list = await listDir(udid, root);
          for (const e of list) {
            if (e.isDir !== 1) continue;
            out.push({ name: e.name, path: joinPath(root, e.name) });
          }
        } catch (e: any) {
          // Some roots may be permission denied (notably /data/app on non-rooted devices).
          // Keep going, but keep the first error for display.
          if (!appsError) setAppsError(String(e?.message || e || `Cannot read ${root}`));
        }
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      setApps(out);
    } finally {
      setAppsLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== 'apps') return;
    refreshApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, udid]);

  useEffect(() => {
    (window as any).__disableDirectKeyboard = tab === 'shell';
    return () => {
      (window as any).__disableDirectKeyboard = false;
    };
  }, [tab]);

  const filteredApps = useMemo(() => {
    const q = appsFilter.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q));
  }, [apps, appsFilter]);

  return (
    <div
      id="viewerPanel"
      style={{ width: '100%', ['--viewer-aspect' as any]: viewerAspect }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="viewerHeader">
        <div className="viewerTitle">
          <div className="viewerUdid">{udid}</div>
          <div className="viewerStatus">{status === 'ready' ? 'LIVE' : 'loading…'}</div>
        </div>

        <div className="viewerHeaderRight">
          <div className="viewerTabs">
            <button className={`viewerTab ${tab === 'view' ? 'on' : ''}`} onClick={() => setTab('view')}>
              View
            </button>
            <button className={`viewerTab ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')}>
              Files
            </button>
            <button className={`viewerTab ${tab === 'apps' ? 'on' : ''}`} onClick={() => setTab('apps')}>
              Apps
            </button>
            <button className={`viewerTab ${tab === 'shell' ? 'on' : ''}`} onClick={() => setTab('shell')}>
              Shell
            </button>
          </div>

          <button className="viewerClose" onClick={onClose} title="Close">
            <X size={18} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className={`viewerBody${tab === 'view' ? ' viewMode' : ''}`} ref={bodyRef}>
        {tab === 'view' ? (
          <div className="viewerMain">
            <div className="viewerCanvasWrap" style={{ transform: 'none' }}>
              <canvas ref={canvasRef} className="viewerCanvas" style={{ touchAction: 'none' }} tabIndex={0} />
            </div>
            <div className="viewerActions">
              <button className="viewerActionBtn" title="Nguồn" onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_POWER)}>
                <Power size={20} strokeWidth={1.8} />
              </button>
              <button
                className="viewerActionBtn"
                title="Tăng âm lượng"
                onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_VOLUME_UP)}
              >
                <Volume2 size={20} strokeWidth={1.8} />
              </button>
              <button
                className="viewerActionBtn"
                title="Giảm âm lượng"
                onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_VOLUME_DOWN)}
              >
                <VolumeX size={20} strokeWidth={1.8} />
              </button>
              <div className="viewerActionSep" />
              <button
                className="viewerActionBtn"
                title="Quay lại"
                onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_BACK)}
              >
                <ArrowLeft size={20} strokeWidth={1.8} />
              </button>
              <button
                className="viewerActionBtn"
                title="Home"
                onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_HOME)}
              >
                <Home size={20} strokeWidth={1.8} />
              </button>
              <button
                className="viewerActionBtn"
                title="Đa nhiệm"
                onClick={() => sendKeyToThis(AndroidKeycode.KEYCODE_APP_SWITCH)}
              >
                <Menu size={20} strokeWidth={1.8} />
              </button>
              <div className="viewerActionSep" />
              <button className="viewerActionBtn" title="Chụp màn hình" onClick={takeScreenshot}>
                <Camera size={20} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'files' ? (
          <div className="viewerPanelInner">
            <div className="viewerFsTop">
              <button className="viewerFsBtn" onClick={() => refreshDir(parent)} disabled={!parent || fileLoading}>
                <ArrowLeft size={16} strokeWidth={1.8} />
                <span style={{ marginLeft: 6 }}>Up</span>
              </button>
              <button className="viewerFsBtn" onClick={() => refreshDir(cwd)} disabled={fileLoading}>
                <RefreshCw size={16} strokeWidth={1.8} />
                <span style={{ marginLeft: 6 }}>Refresh</span>
              </button>
              <button
                className="viewerFsBtn"
                onClick={() => uploadInputRef.current?.click()}
                disabled={fileLoading}
              >
                ⬆ Upload
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => onUploadPick(e.target.files?.[0] || null)}
              />
            </div>

            <div className="viewerFsPath">
              <input
                className="viewerFsPathInput"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') refreshDir(e.currentTarget.value);
                }}
              />
              <button className="viewerFsBtn" onClick={() => refreshDir(cwd)} disabled={fileLoading}>
                Go
              </button>
            </div>

            {fileError ? <div className="viewerError">{fileError}</div> : null}

            <div className="viewerFsMain">
              <div className="viewerFsList">
                {fileLoading ? <div className="viewerHint">Loading…</div> : null}
                {!fileLoading && !entries.length ? <div className="viewerHint">No entries</div> : null}
                {entries.map((e) => (
                  <button
                    key={e.fullPath}
                    className="viewerFsRow"
                    onClick={() => {
                      if (e.isDirBool) {
                        setPreview({ kind: 'none' });
                        refreshDir(joinPath(cwd, e.name + '/'));
                      } else {
                        openFile(e.fullPath, e.name);
                      }
                    }}
                  >
                    <span className="viewerFsName">
                      {e.isDirBool ? (
                        <Folder size={16} strokeWidth={1.8} style={{ marginRight: 8, flexShrink: 0 }} />
                      ) : (
                        <FileText size={16} strokeWidth={1.8} style={{ marginRight: 8, flexShrink: 0 }} />
                      )}
                      {e.name}
                    </span>
                    {!e.isDirBool ? <span className="viewerFsMeta">{e.size}b</span> : null}
                  </button>
                ))}
              </div>

              <div className="viewerFsPreview">
                {preview.kind === 'none' ? <div className="viewerHint">Select a file to preview</div> : null}
                {preview.kind === 'text' ? (
                  <pre className="viewerFsText">{preview.text}</pre>
                ) : null}
                {preview.kind === 'image' ? (
                  <>
                    <div className="viewerFsPreviewTop">
                      <button className="viewerFsBtn" onClick={downloadCurrentPreview}>
                        <Download size={16} strokeWidth={1.8} style={{ marginRight: 6 }} />
                        Download
                      </button>
                      <div className="viewerFsSmall">{preview.path}</div>
                    </div>
                    <img className="viewerFsImg" src={preview.url} alt={preview.path} />
                  </>
                ) : null}
                {preview.kind === 'blob' ? (
                  <>
                    <div className="viewerFsPreviewTop">
                      <button className="viewerFsBtn" onClick={downloadCurrentPreview}>
                        <Download size={16} strokeWidth={1.8} style={{ marginRight: 6 }} />
                        Download
                      </button>
                      <a className="viewerFsBtn" href={preview.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </div>
                    <div className="viewerHint">Binary file preview (download/open)</div>
                    <div className="viewerFsSmall">{preview.path}</div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'apps' ? (
          <div className="viewerPanelInner">
            <div className="viewerFsTop">
              <button className="viewerFsBtn" onClick={() => refreshApps()} disabled={appsLoading}>
                <RefreshCw size={16} strokeWidth={1.8} />
                <span style={{ marginLeft: 6 }}>Refresh</span>
              </button>
              <input
                className="viewerFsPathInput"
                placeholder="Filter apps…"
                value={appsFilter}
                onChange={(e) => setAppsFilter(e.target.value)}
              />
            </div>

            <div className="viewerHint" style={{ marginBottom: 8 }}>
              Apps list is <b>best-effort</b> (based on readable app directories). Some devices block /data/app without root.
            </div>

            {appsError ? <div className="viewerError">{appsError}</div> : null}
            {appsLoading ? <div className="viewerHint">Loading…</div> : null}

            <div className="viewerAppsList">
              {filteredApps.map((a) => (
                <div key={a.path} className="viewerAppsRow">
                  <div className="viewerAppsName">{a.name}</div>
                  <div className="viewerAppsPath">{a.path}</div>
                </div>
              ))}
              {!appsLoading && !filteredApps.length ? <div className="viewerHint">No apps found</div> : null}
            </div>
          </div>
        ) : null}

        {tab === 'shell' ? (
          <div className="viewerPanelInner viewerShellWrap" ref={shellWrapRef}>
            <ShellPage wsServer={wsServer} udid={udid} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const DeviceViewer = memo(DeviceViewerComponent);
