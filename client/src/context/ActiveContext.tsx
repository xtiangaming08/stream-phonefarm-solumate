import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { encodeKeycodeMessage, KeyEventAction } from '@/lib/control';

type Getter<T> = () => T | null;

type DeviceRef = {
  getWs: Getter<WebSocket>;
  getCanvas: Getter<HTMLCanvasElement>;
};

export type InputTarget = {
  udid: string;
  ws: WebSocket;
  canvas: HTMLCanvasElement;
};

function uniq(arr: string[]) {
  const s = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!s.has(x)) {
      s.add(x);
      out.push(x);
    }
  }
  return out;
}

type ActiveContextValue = {
  /** Tile currently focused by click / interaction. Always 0..1 device. */
  activeUdid: string | null;
  selectOnly: (udid: string) => void;
  registeredUdids: string[];

  /** Called by tiles to register their WS/canvas accessors */
  registerDevice: (args: {
    udid: string;
    getWs: Getter<WebSocket>;
    getCanvas: Getter<HTMLCanvasElement>;
  }) => void;
  unregisterDevice: (udid: string) => void;

  /** Send raw control payload (touch/key/text...) to current control target(s) */
  sendToActive: (u8: Uint8Array) => boolean;

  /** Common helpers */
  sendKeyTap: (keycode: number) => void;
  screenshotActiveCanvas: () => void;

  /** For "open device" viewer: mirror the latest decoded canvas */
  getCanvasForUdid: (udid: string) => HTMLCanvasElement | null;

  /** Resolve WS/canvas targets for a list of udids (only OPEN WS + valid canvas). */
  getTargetsByUdids: (udids: string[]) => InputTarget[];

  /** For touch controls: decide which devices should receive input from this source tile */
  getInputTargetsForSource: (sourceUdid: string) => InputTarget[];

  /** Sync/broadcast controls */
  syncAll: boolean;
  setSyncAll: (enabled: boolean) => void;
  syncMain: string | null;
  setSyncMain: (udid: string | null) => void;
  syncTargets: string[];
  toggleSyncTarget: (udid: string) => void;
  setSyncTargetsList: (next: string[]) => void;
  stopSync: () => void;
};

const Ctx = createContext<ActiveContextValue | null>(null);

export function ActiveProvider({ children }: { children: React.ReactNode }) {
  const devicesRef = useRef<Map<string, DeviceRef>>(new Map());

  const [activeUdid, setActiveUdid] = useState<string | null>(null);
  const [registeredUdids, setRegisteredUdids] = useState<string[]>([]);
  const [syncAll, setSyncAll] = useState<boolean>(() => {
    try {
      return localStorage.getItem('syncAll') === '1';
    } catch {
      return false;
    }
  });
  const [syncMain, setSyncMainState] = useState<string | null>(() => {
    try {
      return localStorage.getItem('syncMain') || null;
    } catch {
      return null;
    }
  });
  const [syncTargets, setSyncTargets] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('syncTargets');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return uniq(parsed.map(String));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('syncAll', syncAll ? '1' : '0');
    } catch {
      // ignore
    }
  }, [syncAll]);

  useEffect(() => {
    try {
      if (syncMain) localStorage.setItem('syncMain', syncMain);
      else localStorage.removeItem('syncMain');
    } catch {
      // ignore
    }
  }, [syncMain]);

  useEffect(() => {
    try {
      localStorage.setItem('syncTargets', JSON.stringify(syncTargets));
    } catch {
      // ignore
    }
  }, [syncTargets]);

  const registerDevice = useCallback(
    (args: { udid: string; getWs: Getter<WebSocket>; getCanvas: Getter<HTMLCanvasElement> }) => {
      devicesRef.current.set(args.udid, { getWs: args.getWs, getCanvas: args.getCanvas });
      setRegisteredUdids(Array.from(devicesRef.current.keys()));
    },
    [],
  );

  const unregisterDevice = useCallback((udid: string) => {
    devicesRef.current.delete(udid);
    setActiveUdid((prev) => (prev === udid ? null : prev));
    setRegisteredUdids(Array.from(devicesRef.current.keys()));
  }, []);

  const selectOnly = useCallback((udid: string) => {
    setActiveUdid(udid);
  }, []);

  useEffect(() => {
    // Drop main/targets that are no longer mounted
    setSyncTargets((prev) => prev.filter((u) => devicesRef.current.has(u)));
    setSyncMainState((prev) => (prev && devicesRef.current.has(prev) ? prev : null));
  }, [registeredUdids]);

  useEffect(() => {
    if (!syncMain) return;
    // main should not appear in follower list
    setSyncTargets((prev) => prev.filter((u) => u !== syncMain));
  }, [syncMain]);

  const getTargetsByUdids = useCallback((udids: string[]): InputTarget[] => {
    const out: InputTarget[] = [];
    for (const udid of udids) {
      const ref = devicesRef.current.get(udid);
      if (!ref) continue;
      const ws = ref.getWs();
      const canvas = ref.getCanvas();
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      if (!canvas) continue;
      out.push({ udid, ws, canvas });
    }
    return out;
  }, []);

  const getAllTargets = useCallback((): InputTarget[] => {
    const out: InputTarget[] = [];
    for (const [udid, ref] of devicesRef.current.entries()) {
      const ws = ref.getWs();
      const canvas = ref.getCanvas();
      if (!ws || ws.readyState !== WebSocket.OPEN) continue;
      if (!canvas) continue;
      out.push({ udid, ws, canvas });
    }
    return out;
  }, []);

  const resolveTargets = useCallback(
    (sourceUdid: string | null): InputTarget[] => {
      if (!sourceUdid) return [];
      if (syncAll) {
        if (!syncMain) {
          const ids = uniq([sourceUdid, ...syncTargets.filter(Boolean)]);
          return getTargetsByUdids(ids);
        }
        if (syncMain && sourceUdid === syncMain) {
          const ids = uniq([sourceUdid, ...syncTargets.filter(Boolean)]);
          return getTargetsByUdids(ids);
        }
      }
      return getTargetsByUdids([sourceUdid]);
    },
    [getTargetsByUdids, syncAll, syncMain, syncTargets],
  );

  const getInputTargetsForSource = useCallback(
    (sourceUdid: string): InputTarget[] => {
      return resolveTargets(sourceUdid);
    },
    [resolveTargets],
  );

  const sendToActive = useCallback(
    (u8: Uint8Array): boolean => {
      const targets = resolveTargets(activeUdid);
      if (!targets.length) return false;
      for (const t of targets) {
        try {
          t.ws.send(u8);
        } catch {
          // ignore
        }
      }
      return true;
    },
    [activeUdid, resolveTargets],
  );

  const sendKeyTap = useCallback(
    (keycode: number) => {
      sendToActive(encodeKeycodeMessage(KeyEventAction.DOWN, keycode));
      sendToActive(encodeKeycodeMessage(KeyEventAction.UP, keycode));
    },
    [sendToActive],
  );

  const screenshotActiveCanvas = useCallback(() => {
    // Screenshot always uses the focused device (activeUdid), not the multi-control group.
    // (This matches the user's mental model: "I click a device => it's active".)
    if (!activeUdid) return;
    const ref = devicesRef.current.get(activeUdid);
    const c = ref?.getCanvas ? ref.getCanvas() : null;
    if (!c) return;
    try {
      const a = document.createElement('a');
      a.download = `scrcpy_${Date.now()}.png`;
      a.href = c.toDataURL('image/png');
      a.click();
    } catch (e) {
      console.warn('screenshot failed', e);
    }
  }, [activeUdid]);

  const getCanvasForUdid = useCallback((udid: string) => {
    const ref = devicesRef.current.get(udid);
    return ref?.getCanvas ? ref.getCanvas() : null;
  }, []);

  const setSyncTargetsList = useCallback((next: string[]) => {
    setSyncTargets(uniq(next));
  }, []);

  const setSyncMain = useCallback(
    (next: string | null) => {
      setSyncMainState((prev) => {
        // When switching main while sync is on, move old main into followers automatically.
        if (prev && next && prev !== next && syncAll) {
          setSyncTargets((prevTargets) => {
            const cleaned = prevTargets.filter((u) => u !== next);
            return uniq([...cleaned, prev]);
          });
        }
        return next;
      });
    },
    [syncAll],
  );

  const stopSync = useCallback(() => {
    setSyncAll(false);
    setSyncMainState(null);
    setSyncTargets([]);
  }, []);

  const value = useMemo<ActiveContextValue>(
    () => ({
      activeUdid,
      selectOnly,
      registeredUdids,
      registerDevice,
      unregisterDevice,
      sendToActive,
      sendKeyTap,
      screenshotActiveCanvas,
      getCanvasForUdid,
      getTargetsByUdids,
      getInputTargetsForSource,
      syncAll,
      setSyncAll,
      syncMain,
      setSyncMain,
      syncTargets,
      toggleSyncTarget: (udid: string) => {
        setSyncTargets((prev) => {
          const exists = prev.includes(udid);
          const next = exists ? prev.filter((u) => u !== udid) : [...prev, udid];
          return uniq(next);
        });
      },
      setSyncTargetsList,
      stopSync,
    }),
    [
      activeUdid,
      selectOnly,
      registeredUdids,
      registerDevice,
      unregisterDevice,
      sendToActive,
      sendKeyTap,
      screenshotActiveCanvas,
      getCanvasForUdid,
      getTargetsByUdids,
      getInputTargetsForSource,
      syncAll,
      setSyncAll,
      syncMain,
      syncTargets,
      setSyncTargetsList,
      stopSync,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActive() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useActive must be used within ActiveProvider');
  return v;
}
