import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class KeepAwakeService {
    private static instance?: KeepAwakeService;
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    private constructor() {
        // singleton
    }

    public static getInstance(): KeepAwakeService {
        if (!this.instance) {
            this.instance = new KeepAwakeService();
        }
        return this.instance;
    }

    public async keepAwake(deviceId: string, durationMs: number): Promise<void> {
        if (!deviceId) {
            throw new Error('Invalid device id');
        }
        const safeDuration = Math.max(1000, durationMs || 30000);
        await this.execAdb(['-s', deviceId, 'shell', 'svc', 'power', 'stayon', 'true'], 'keep-awake-on');
        // Wake screen
        await this.execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', '224'], 'wake-screen').catch(() => undefined);
        // Reset existing timer
        const existing = this.timers.get(deviceId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.execAdb(['-s', deviceId, 'shell', 'svc', 'power', 'stayon', 'false'], 'keep-awake-off').catch(() => undefined);
            this.timers.delete(deviceId);
        }, safeDuration);
        this.timers.set(deviceId, timer);
    }

    private async execAdb(args: string[], label: string): Promise<string> {
        try {
            const { stdout, stderr } = await execFileAsync('adb', args);
            return (stdout + '\n' + stderr).trim();
        } catch (error: any) {
            const out = ((error?.stdout || '') + '\n' + (error?.stderr || '')).trim();
            throw new Error(out || error?.message || `${label} failed`);
        }
    }
}
