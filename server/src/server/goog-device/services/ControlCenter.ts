import { TrackerChangeSet } from '@dead50f7/adbkit/lib/TrackerChangeSet';
import { Device } from '../Device';
import { Service } from '../../services/Service';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { AdbExtended } from '../adb';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import Tracker from '@dead50f7/adbkit/lib/adb/tracker';
import { BaseControlCenter } from '../../services/BaseControlCenter';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import * as os from 'os';
import * as crypto from 'crypto';
import { DeviceState } from '../../../common/DeviceState';
import VideoSettings from '../../../common/VideoSettings';
type Timeout = ReturnType<typeof setTimeout>;

export class ControlCenter extends BaseControlCenter<GoogDeviceDescriptor> implements Service {
    private static readonly defaultWaitAfterError = 1000;
    private static instance?: ControlCenter;

    private initialized = false;
    private client: AdbKitClient = AdbExtended.createClient();
    private tracker?: Tracker;
    private waitAfterError = 1000;
    private restartTimeoutId?: Timeout;
    private deviceMap: Map<string, Device> = new Map();
    private descriptors: Map<string, GoogDeviceDescriptor> = new Map();
    private videoSettings: Map<string, VideoSettings> = new Map();
    private readonly id: string;

    protected constructor() {
        super();
        const idString = `goog|${os.hostname()}|${os.uptime()}`;
        this.id = crypto.createHash('md5').update(idString).digest('hex');
    }

    public static getInstance(): ControlCenter {
        if (!this.instance) {
            this.instance = new ControlCenter();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!ControlCenter.instance;
    }

    private restartTracker = (): void => {
        if (this.restartTimeoutId) {
            return;
        }
        console.log(`Device tracker is down. Will try to restart in ${this.waitAfterError}ms`);
        this.restartTimeoutId = setTimeout(() => {
            this.stopTracker();
            this.waitAfterError *= 1.2;
            this.init();
        }, this.waitAfterError);
    };

    private onChangeSet = (changes: TrackerChangeSet): void => {
        this.waitAfterError = ControlCenter.defaultWaitAfterError;
        if (changes.added.length) {
            for (const item of changes.added) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
        if (changes.removed.length) {
            for (const item of changes.removed) {
                const { id } = item;
                this.handleConnected(id, DeviceState.DISCONNECTED);
            }
        }
        if (changes.changed.length) {
            for (const item of changes.changed) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
    };

    private onDeviceUpdate = (device: Device): void => {
        const { udid, descriptor } = device;
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
    };

    private handleConnected(udid: string, state: string): void {
        let device = this.deviceMap.get(udid);
        if (device) {
            device.setState(state);
        } else {
            device = new Device(udid, state);
            device.on('update', this.onDeviceUpdate);
            this.deviceMap.set(udid, device);
        }
    }

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.tracker = await this.startTracker();
        const list = await this.client.listDevices();
        list.forEach((device) => {
            const { id, type } = device;
            this.handleConnected(id, type);
        });
        this.initialized = true;
    }

    private async startTracker(): Promise<Tracker> {
        if (this.tracker) {
            return this.tracker;
        }
        const tracker = await this.client.trackDevices();
        tracker.on('changeSet', this.onChangeSet);
        tracker.on('end', this.restartTracker);
        tracker.on('error', this.restartTracker);
        return tracker;
    }

    private stopTracker(): void {
        if (this.tracker) {
            this.tracker.off('changeSet', this.onChangeSet);
            this.tracker.off('end', this.restartTracker);
            this.tracker.off('error', this.restartTracker);
            this.tracker.end();
            this.tracker = undefined;
        }
        this.tracker = undefined;
        this.initialized = false;
    }

    public getDevices(): GoogDeviceDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    public getDevice(udid: string): Device | undefined {
        return this.deviceMap.get(udid);
    }

    private async runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined | number;
        return Promise.race<T>([
            promise.finally(() => {
                if (timer) {
                    clearTimeout(timer);
                }
            }),
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
    }

    public async getDevicePid(udid: string, timeoutMs = 5000): Promise<number | undefined> {
        const device = this.getDevice(udid);
        if (!device) {
            throw new Error(`Device with udid:"${udid}" not found`);
        }
        return this.runWithTimeout(device.getServerPid(), timeoutMs, 'Get server pid');
    }

    public async restartDevice(udid: string, pid?: number, timeoutMs = 20000): Promise<number> {
        const device = this.getDevice(udid);
        if (!device) {
            throw new Error(`Device with udid:"${udid}" not found`);
        }
        let targetPid = pid;
        if (typeof targetPid !== 'number' || targetPid <= 0) {
            targetPid = await this.getDevicePid(udid, Math.min(3000, timeoutMs));
        }
        if (typeof targetPid === 'number' && targetPid > 0) {
            await this.runWithTimeout(device.killServer(targetPid), Math.min(5000, timeoutMs), 'Kill server');
        }
        const startedPid = await this.runWithTimeout(device.startServer(), timeoutMs, 'Start server');
        if (typeof startedPid !== 'number' || startedPid <= 0) {
            throw new Error('Server did not start');
        }
        return startedPid;
    }

    public setVideoSettings(
        udid: string,
        settings: Partial<{
            crop: VideoSettings['crop'];
            bitrate: number;
            bounds: VideoSettings['bounds'];
            maxFps: number;
            iFrameInterval: number;
            sendFrameMeta: boolean;
            lockedVideoOrientation: number;
            displayId: number;
            codecOptions: string;
            encoderName: string;
        }>,
    ): VideoSettings {
        const normalizeNumber = (value: any, fallback = 0): number => {
            const n = Number(value);
            return isNaN(n) ? fallback : n;
        };
        const videoSettings = new VideoSettings({
            crop: settings.crop ?? null,
            bitrate: normalizeNumber(settings.bitrate, 0),
            bounds: settings.bounds ?? null,
            maxFps: normalizeNumber(settings.maxFps, 0),
            iFrameInterval: normalizeNumber(settings.iFrameInterval, 0),
            sendFrameMeta: !!settings.sendFrameMeta,
            lockedVideoOrientation: normalizeNumber(settings.lockedVideoOrientation, -1),
            displayId: normalizeNumber(settings.displayId, 0),
            codecOptions: settings.codecOptions,
            encoderName: settings.encoderName,
        });
        this.videoSettings.set(udid, videoSettings);
        return videoSettings;
    }

    public getVideoSettings(udid: string): VideoSettings | undefined {
        return this.videoSettings.get(udid);
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return `aDevice Tracker [${os.hostname()}]`;
    }

    public start(): Promise<void> {
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
        });
    }

    public release(): void {
        this.stopTracker();
    }

    public async runCommand(command: ControlCenterCommand): Promise<void> {
        const udid = command.getUdid();
        const device = this.getDevice(udid);
        if (!device) {
            console.error(`Device with udid:"${udid}" not found`);
            return;
        }
        const type = command.getType();
        switch (type) {
            case ControlCenterCommand.KILL_SERVER:
                await device.killServer(command.getPid());
                return;
            case ControlCenterCommand.START_SERVER:
                await device.startServer();
                return;
            case ControlCenterCommand.RESTART_SERVER:
                await device.killServer(command.getPid());
                await device.startServer();
                return;
            case ControlCenterCommand.UPDATE_INTERFACES:
                await device.updateInterfaces();
                return;
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
