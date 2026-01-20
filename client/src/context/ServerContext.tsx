import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  GoogDeviceDescriptor,
  listDevtools,
  listDir,
  pullFile,
  pushFile,
  RemoteDevtoolsInfo,
  statPath,
  type FileStats,
} from '@/lib/serverApi';

type ServerContextValue = {
  wsServer: string;
  androidDevices: GoogDeviceDescriptor[];
  androidDeviceMap: Record<string, GoogDeviceDescriptor>;
  trackerMeta: { id: string; name: string } | null;
  startScrcpyServer: (udid: string) => void;
  killScrcpyServer: (udid: string, pid: number) => void;
  updateInterfaces: (udid: string) => void;
  listDevtools: (udid: string) => Promise<RemoteDevtoolsInfo[]>;
  listDir: (udid: string, remotePath: string) => Promise<FileStats[]>;
  statPath: (udid: string, remotePath: string) => Promise<{ isDir: boolean; size: number; mtimeMs: number }>;
  pullFile: (udid: string, remotePath: string) => Promise<Blob>;
  pushFile: (udid: string, file: File, remotePath: string) => Promise<void>;
};

const Ctx = createContext<ServerContextValue | null>(null);

export function ServerProvider({ wsServer, children }: { wsServer: string; children: React.ReactNode }) {
  const [androidDevices, setAndroidDevices] = useState<GoogDeviceDescriptor[]>([]);
  const [trackerMeta, setTrackerMeta] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    // Socket tracker disabled per request; keep empty state.
    setAndroidDevices([]);
    setTrackerMeta(null);
  }, [wsServer]);

  const androidDeviceMap = useMemo(() => {
    const out: Record<string, GoogDeviceDescriptor> = {};
    for (const d of androidDevices) out[d.udid] = d;
    return out;
  }, [androidDevices]);

  const send = (_cmd: any, _data: any) => {};

  const value: ServerContextValue = {
    wsServer,
    androidDevices,
    androidDeviceMap,
    trackerMeta,
    startScrcpyServer: (udid) => send('start_server', { udid }),
    killScrcpyServer: (udid, pid) => send('kill_server', { udid, pid }),
    updateInterfaces: (udid) => send('update_interfaces', { udid }),
    listDevtools: (udid) => listDevtools(wsServer, udid),
    listDir: (udid, remotePath) => listDir(wsServer, udid, remotePath),
    statPath: (udid, remotePath) => statPath(wsServer, udid, remotePath),
    pullFile: (udid, remotePath) => pullFile(wsServer, udid, remotePath),
    pushFile: (udid, file, remotePath) => pushFile(wsServer, udid, file, remotePath),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServer() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useServer must be used within ServerProvider');
  return v;
}
