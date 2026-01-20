import type { Data as WsData } from 'ws';
import { WebsocketProxy } from '../mw/WebsocketProxy';

export type SyncMapping = {
    target: string;
    devices: string[];
};

export type SyncState = {
    targets: string[];
    devices: string[];
};

export class SyncService {
    private static instance?: SyncService;
    private readonly mapping: Map<string, Set<string>> = new Map();

    private constructor() {
        // singleton
    }

    public static getInstance(): SyncService {
        if (!this.instance) {
            this.instance = new SyncService();
        }
        return this.instance;
    }

    public setMapping(target: string | string[], devices: string[]): SyncState {
        const targetList = Array.isArray(target) ? target : [target];
        const cleanedTargets = Array.from(
            new Set(targetList.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean)),
        );
        const cleanedDevices = Array.from(
            new Set(devices.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean)),
        );
        this.mapping.clear();
        cleanedTargets.forEach((t) => {
            const receivers = new Set(cleanedDevices);
            receivers.delete(t);
            this.mapping.set(t, receivers);
        });
        return this.list();
    }

    public clear(): void {
        this.mapping.clear();
    }

    public list(): SyncState {
        const targets: string[] = [];
        const devices = new Set<string>();
        this.mapping.forEach((deviceSet, target) => {
            targets.push(target);
            deviceSet.forEach((device) => devices.add(device));
        });
        return {
            targets,
            devices: Array.from(devices.values()),
        };
    }

    public mirror(source: string, data: WsData): void {
        const targets = this.mapping.get(source);
        if (!targets || !targets.size) {
            return;
        }
        targets.forEach((device) => {
            const proxy = WebsocketProxy.getBySession(device);
            if (!proxy) {
                return;
            }
            proxy.forwardFromSync(data);
        });
    }
}
