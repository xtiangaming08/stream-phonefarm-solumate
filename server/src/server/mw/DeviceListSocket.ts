import WS from 'ws';
import { Mw, RequestParameters } from './Mw';
import { ACTION } from '../../common/Action';
import { AdbExtended } from '../goog-device/adb';
import { RecordingStatusService, RecordingState } from '../services/RecordingStatusService';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConnectPreferenceService } from '../services/ConnectPreferenceService';
import Tracker from '@dead50f7/adbkit/lib/adb/tracker';
import Client from '@dead50f7/adbkit/lib/adb/client';

type DevicePayload = {
    device: string;
    status_recodd: RecordingState | 'stop';
    ipv4: string;
    uuid: string;
    connect_type: 'wifi' | 'usb';
};

const execFileAsync = promisify(execFile);

export class DeviceListSocket extends Mw {
    public static readonly TAG = 'DeviceListSocket';
    private static readonly IFACES = ['wlan0', 'eth0'];
    private static readonly CACHE_TTL = 5000;
    private static sockets: Set<DeviceListSocket> = new Set();
    private static tracker?: Tracker;
    private static trackerInit?: Promise<void>;
    private static trackerRestartTimer?: ReturnType<typeof setTimeout>;
    private static refreshing = false;
    private static pending = false;
    private static serialCache: Map<string, { value: string; ts: number }> = new Map();
    private static ipCache: Map<string, { value: string; ts: number }> = new Map();
    private static deviceIdsCache?: { value: string[]; ts: number };

    public static processRequest(ws: WS, params: RequestParameters): DeviceListSocket | undefined {
        const { action } = params;
        if (action !== ACTION.DEVICES_LIST) {
            return;
        }
        return new DeviceListSocket(ws);
    }

    constructor(ws: WS) {
        super(ws);
        DeviceListSocket.sockets.add(this);
        DeviceListSocket.ensureTracker();
        // send a quick cached/lightweight response immediately, then refresh in background
        void DeviceListSocket.quickSendCachedOrIds();
        void DeviceListSocket.refreshAndBroadcast(true);
    }

    protected onSocketMessage(_event: WS.MessageEvent): void {
        void DeviceListSocket.quickSendCachedOrIds();
        void DeviceListSocket.refreshAndBroadcast(true);
    }

    private static async quickSendCachedOrIds(): Promise<void> {
        try {
            const now = Date.now();
            const cached = this.deviceIdsCache;
            let ids: string[] = [];
            if (cached && now - cached.ts < this.CACHE_TTL) {
                ids = [...cached.value];
            } else {
                // attempt fast adbkit listing but do not block on failures
                ids = await this.listDevicesFromAdbKit().catch(() => [] as string[]);
            }

            const statusService = RecordingStatusService.getInstance();
            const statusByDevice = new Map<string, RecordingState>(
                statusService.getAll().map((item) => [item.device, item.status]),
            );

            const quick: DevicePayload[] = ids.map((id) => {
                const isWifi = id.includes(':');
                const connectType: 'wifi' | 'usb' = isWifi ? 'wifi' : 'usb';
                const status = statusByDevice.get(id) ?? 'stop';
                return {
                    device: id,
                    status_recodd: status,
                    ipv4: isWifi ? this.parseIp(id) : '',
                    uuid: isWifi ? '' : id,
                    connect_type: connectType,
                };
            });

            this.sockets.forEach((socket) => {
                if (socket.ws.readyState === socket.ws.OPEN) {
                    socket.ws.send(JSON.stringify(quick));
                }
            });
        } catch (e: any) {
            // swallow quick-send errors to avoid blocking primary flow
        }
    }

    public release(): void {
        DeviceListSocket.sockets.delete(this);
        super.release();
    }

    public static async collectDevices(): Promise<DevicePayload[]> {
        const statusService = RecordingStatusService.getInstance();
        const statusByDevice = new Map<string, RecordingState>(
            statusService.getAll().map((item) => [item.device, item.status]),
        );
        const preferenceService = ConnectPreferenceService.getInstance();
        try {
            const ids = await this.listDeviceIds();
            const raw = await this.runWithLimit(ids, 8, async (id): Promise<DevicePayload | undefined> => {
                const isWifi = id.includes(':');
                const connectType: 'wifi' | 'usb' = isWifi ? 'wifi' : 'usb';
                const ipv4 = isWifi ? this.parseIp(id) : await this.getDeviceIp(id);
                const uuid = isWifi ? (await this.getSerial(id)) || '' : id;
                const status = statusByDevice.get(id) ?? statusByDevice.get(uuid) ?? 'stop';
                return {
                    device: id,
                    status_recodd: status,
                    ipv4: ipv4 || '',
                    uuid,
                    connect_type: connectType,
                };
            }).then((list) => list.filter(Boolean) as DevicePayload[]);
            const grouped = new Map<string, DevicePayload[]>();
            raw.forEach((item) => {
                const key = item.uuid || item.device;
                if (!grouped.has(key)) {
                    grouped.set(key, []);
                }
                grouped.get(key)?.push(item);
            });
            const filtered: DevicePayload[] = [];
            grouped.forEach((list, key) => {
                const pref = preferenceService.getPreference(key);
                let chosen: DevicePayload | undefined;
                if (pref) {
                    chosen = list.find((i) => i.connect_type === pref);
                }
                if (!chosen) {
                    chosen = list[0];
                }
                if (chosen) {
                    filtered.push(chosen);
                }
            });
            return filtered;
        } catch (error: any) {
            console.error(`[${this.TAG}] Failed to list devices: ${error?.message || error}`);
            return [];
        }
    }

    private static async refreshAndBroadcast(force = false): Promise<void> {
        if (force) {
            // force fresh device id lookup
            this.deviceIdsCache = undefined;
        }
        if (this.refreshing) {
            this.pending = true;
            return;
        }
        this.refreshing = true;
        try {
            const devices = await this.collectDevices();
            this.sockets.forEach((socket) => {
                if (socket.ws.readyState === socket.ws.OPEN) {
                    socket.ws.send(JSON.stringify(devices));
                }
            });
        } catch (error: any) {
            console.error(`[${this.TAG}] Failed to broadcast devices: ${error?.message || error}`);
        } finally {
            this.refreshing = false;
            if (this.pending) {
                this.pending = false;
                void this.refreshAndBroadcast();
            }
        }
    }

    private static ensureTracker(): void {
        if (this.trackerInit) {
            return;
        }
        this.trackerInit = (async () => {
            try {
                const client = AdbExtended.createClient();
                this.tracker = await client.trackDevices();
                this.tracker.on('changeSet', () => {
                    // device list changed, invalidate cache and push update
                    this.deviceIdsCache = undefined;
                    void DeviceListSocket.refreshAndBroadcast(true);
                });
                this.tracker.on('change', () => {
                    this.deviceIdsCache = undefined;
                    void DeviceListSocket.refreshAndBroadcast(true);
                });
                const onError = (e?: Error) => {
                    console.error(`[${this.TAG}] tracker error: ${e?.message || e}`);
                    this.deviceIdsCache = undefined;
                    this.scheduleTrackerRestart();
                };
                this.tracker.on('error', onError);
                this.tracker.on('end', () => this.scheduleTrackerRestart());
            } catch (error: any) {
                console.error(`[${this.TAG}] Failed to start adb tracker: ${error?.message || error}`);
                this.scheduleTrackerRestart();
            }
        })();
    }

    private static scheduleTrackerRestart(): void {
        if (this.trackerRestartTimer) {
            return;
        }
        this.trackerInit = undefined;
        this.trackerRestartTimer = setTimeout(() => {
            this.trackerRestartTimer = undefined;
            this.ensureTracker();
        }, 1000);
    }

    private static parseIp(id: string): string {
        return id.includes(':') ? id.split(':')[0] : id;
    }

    private static async listDeviceIds(): Promise<string[]> {
        const now = Date.now();
        const cached = this.deviceIdsCache;
        if (cached && now - cached.ts < this.CACHE_TTL) {
            return [...cached.value];
        }

        const ids = new Set<string>();
        // Prefer adbkit (no separate adb binary call which may restart adb server)
        const listed = await this.listDevicesFromAdbKit().catch(() => [] as string[]);
        listed.forEach((id) => ids.add(id));

        // Fallback to `adb devices` only if adbkit returned nothing
        if (!ids.size) {
            const raw = await this.listDevicesFromAdb().catch(() => [] as string[]);
            raw.forEach((id) => ids.add(id));
        }

        const result = Array.from(ids.values());
        this.deviceIdsCache = { value: result, ts: now };
        return result;
    }

    private static async listDevicesFromAdb(): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('adb', ['devices']);
            return this.parseAdbDevices(stdout || '');
        } catch (error: any) {
            console.error(`[${this.TAG}] Failed to run "adb devices": ${error?.message || error}`);
            return [];
        }
    }

    private static async listDevicesFromAdbKit(): Promise<string[]> {
        try {
            const client: Client = AdbExtended.createClient();
            const listed = await client.listDevices();
            return listed.filter((d) => !d.type || d.type === 'device').map((d) => d.id);
        } catch (error: any) {
            console.error(`[${this.TAG}] Failed to list devices via adbkit: ${error?.message || error}`);
            return [];
        }
    }

    private static parseAdbDevices(output: string): string[] {
        const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
        const result: string[] = [];
        for (const line of lines) {
            if (line.startsWith('List of devices')) {
                continue;
            }
            const [id, state] = line.split(/\s+/);
            if (id && state === 'device') {
                result.push(id);
            }
        }
        return result;
    }

    public static async getDeviceIp(serial: string): Promise<string | undefined> {
        const cached = this.ipCache.get(serial);
        const now = Date.now();
        if (cached && now - cached.ts < this.CACHE_TTL) {
            return cached.value;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            const route = await this.runShellSafe(serial, 'ip route get 1.1.1.1');
            const viaRoute = this.pickIpv4(route);
            if (viaRoute) {
                this.ipCache.set(serial, { value: viaRoute, ts: now });
                return viaRoute;
            }

            for (const iface of this.IFACES) {
                const addr = await this.runShellSafe(serial, `ip -f inet addr show ${iface}`);
                const viaIpAddr = this.pickIpv4(addr);
                if (viaIpAddr) {
                    this.ipCache.set(serial, { value: viaIpAddr, ts: now });
                    return viaIpAddr;
                }
            }

            for (const iface of this.IFACES) {
                const cfg = await this.runShellSafe(serial, `ifconfig ${iface}`);
                const viaIfconfig = this.pickIpv4(cfg);
                if (viaIfconfig) {
                    this.ipCache.set(serial, { value: viaIfconfig, ts: now });
                    return viaIfconfig;
                }
            }

            const full = await this.runShellSafe(serial, 'ifconfig');
            for (const iface of this.IFACES) {
                const block = this.extractIfaceBlock(full, iface);
                const viaBlock = this.pickIpv4(block);
                if (viaBlock) {
                    this.ipCache.set(serial, { value: viaBlock, ts: now });
                    return viaBlock;
                }
            }
            await this.delay(300);
        }
        return;
    }

    public static async getSerial(serial: string): Promise<string | undefined> {
        const cached = this.serialCache.get(serial);
        const now = Date.now();
        if (cached && now - cached.ts < this.CACHE_TTL) {
            return cached.value;
        }
        const output = await this.runShellSafe(serial, 'getprop ro.serialno');
        const value = output.trim();
        if (value) {
            this.serialCache.set(serial, { value, ts: now });
        }
        return value || undefined;
    }

    private static async runShell(serial: string, command: string): Promise<string> {
        const client = AdbExtended.createClient();
        const stream = await client.shell(serial, command);
        const buffer = await AdbExtended.util.readAll(stream);
        return buffer.toString();
    }

    private static async runShellSafe(serial: string, command: string): Promise<string> {
        try {
            return await this.runShell(serial, command);
        } catch (error: any) {
            console.error(`[${this.TAG}] Failed to run "${command}" on ${serial}: ${error?.message || error}`);
            return '';
        }
    }

    private static pickIpv4(text?: string): string | undefined {
        if (!text) {
            return;
        }
        const patterns = [
            /\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/,
            /\binet\s+(\d+\.\d+\.\d+\.\d+)\/\d+\b/,
            /\binet\s+addr:\s*(\d+\.\d+\.\d+\.\d+)\b/,
            /\binet\s+(\d+\.\d+\.\d+\.\d+)\b/,
        ];
        for (const re of patterns) {
            const match = re.exec(text);
            if (match && match[1] !== '127.0.0.1') {
                return match[1];
            }
        }
        return;
    }

    private static extractIfaceBlock(ifconfigText: string, iface: string): string | undefined {
        if (!ifconfigText) {
            return;
        }
        const pattern = new RegExp(`^(?:${iface})\\b[\\s\\S]*?(?=^\\S|\\Z)`, 'm');
        const match = pattern.exec(ifconfigText);
        return match ? match[0] : undefined;
    }

    private static delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private static async runWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
        const results: R[] = [];
        let index = 0;
        const workers: Promise<void>[] = [];
        const worker = async () => {
            while (index < items.length) {
                const current = items[index++];
                const res = await fn(current);
                results.push(res);
            }
        };
        const count = Math.min(limit, items.length);
        for (let i = 0; i < count; i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    }
}
