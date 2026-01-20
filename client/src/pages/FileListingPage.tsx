import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listDir, pullFile, pushFile, type FileStats } from '@/lib/serverApi';
import { ArrowUp, FileText, Folder, RefreshCw } from 'lucide-react';

type Props = {
  wsServer: string;
  udid: string;
  initialPath?: string;
};

const ensureDirPath = (p: string): string => {
  if (!p) return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p += '/';
  return p.replace(/\/+/g, '/');
};

const joinPath = (base: string, name: string): string => {
  if (!name) return ensureDirPath(base);
  if (name === '..') {
    const parts = base.replace(/\/+$/, '').split('/');
    parts.pop();
    const parent = parts.join('/') || '/';
    return ensureDirPath(parent);
  }
  if (name.startsWith('/')) return ensureDirPath(name);
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return ensureDirPath(`${cleanBase}/${name}`);
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
};

const formatDate = (ms: number) => {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '-';
  }
};

export function FileListingPage({ wsServer, udid, initialPath }: Props) {
  const [path, setPath] = useState<string>(() => ensureDirPath(initialPath || '/data/local/tmp/'));
  const [entries, setEntries] = useState<FileStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  const refresh = useCallback(
    async (nextPath?: string) => {
      if (!udid) {
        setError('Thiếu udid trong URL hash (?#!action=list-files&udid=...)');
        return;
      }
      const target = ensureDirPath(nextPath ?? path);
      setLoading(true);
      setError(null);
      try {
        const list = await listDir(wsServer, udid, target);
        setEntries(list);
        setPath(target);
      } catch (e: any) {
        setError(e?.message || 'Tải danh sách file thất bại');
      } finally {
        setLoading(false);
      }
    },
    [path, udid, wsServer],
  );

  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadFile = async (name: string) => {
    try {
      const remotePath = `${ensureDirPath(path)}${name}`;
      const blob = await pullFile(wsServer, udid, remotePath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) {
      setError(e?.message || 'Tải file thất bại');
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploadMsg('Đang upload...');
    for (const file of Array.from(files)) {
      const remotePath = `${ensureDirPath(path)}${file.name}`;
      try {
        await pushFile(wsServer, udid, file, remotePath);
        setUploadMsg(`Upload thành công: ${file.name}`);
        await refresh();
      } catch (e: any) {
        setUploadMsg(`Upload lỗi (${file.name}): ${e?.message || 'unknown'}`);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="hashPage fileListPage">
      <div className="pageHeader">
        <div className="title">File listing</div>
        <div className="subtitle">udid: {udid || 'n/a'}</div>
        <div className="subtitle">Path: {path}</div>
        <div className="actionRow">
          <button onClick={() => refresh(joinPath(path, '..'))}>
            <ArrowUp size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
            Lên trên
          </button>
          <button onClick={() => refresh('/')}>/</button>
          <button onClick={() => refresh('/data/local/tmp/')}>/data/local/tmp</button>
          <button onClick={() => refresh('/storage/')}>/storage</button>
          <button onClick={() => refresh()}>
            <RefreshCw size={14} strokeWidth={1.8} style={{ marginRight: 6 }} />
            Refresh
          </button>
          <label className="uploadLabel">
            Upload file
            <input
              ref={inputRef}
              type="file"
              multiple
              onChange={(e) => handleUpload(e.target.files)}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        {uploadMsg ? <div className="statusLine">{uploadMsg}</div> : null}
        {statusOrError(loading, error)}
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: '55%' }}>Name</th>
              <th style={{ width: '15%' }}>Size</th>
              <th style={{ width: '20%' }}>Modified</th>
              <th style={{ width: '10%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((e) => (
              <tr key={e.name}>
                <td>
                  {e.isDir ? (
                    <button className="linkBtn" onClick={() => refresh(joinPath(path, e.name))}>
                      <Folder size={14} strokeWidth={1.8} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                      {e.name}
                    </button>
                  ) : (
                    <span>
                      <FileText size={14} strokeWidth={1.8} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                      {e.name}
                    </span>
                  )}
                </td>
                <td>{e.isDir ? '-' : formatBytes(e.size)}</td>
                <td>{formatDate(e.dateModified)}</td>
                <td>
                  {e.isDir ? null : (
                    <button className="linkBtn" onClick={() => downloadFile(e.name)}>
                      Tải
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!sortedEntries.length ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', opacity: 0.7 }}>
                  {loading ? 'Đang tải…' : 'Thư mục trống'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusOrError(loading: boolean, error: string | null) {
  if (loading) return <div className="statusLine">Đang tải...</div>;
  if (error) return <div className="statusLine error">{error}</div>;
  return null;
}
