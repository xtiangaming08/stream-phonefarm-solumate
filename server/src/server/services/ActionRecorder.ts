import fs from 'fs';
import path from 'path';
import type { Data as WsData } from 'ws';

export type RecordingMeta = {
    device?: string;
    source?: string;
    name?: string;
};

export type RecordedMessage = {
    at: number;
    data: string;
    binary: boolean;
};

export type RecordingFile = {
    id: string;
    remote: string;
    createdAt: string;
    name?: string;
    meta?: RecordingMeta;
    messages: RecordedMessage[];
};

export class ActionRecorder {
    private static readonly ROOT_DIR = path.resolve(process.cwd(), 'recordings');
    private static readonly ID_SAFE_RE = /[^a-zA-Z0-9-_]/g;
    private readonly startedAt = Date.now();
    private pausedAt?: number;
    private pausedDuration = 0;
    private readonly messages: RecordedMessage[] = [];

    constructor(
        private readonly id: string,
        private readonly remote: string,
        private readonly meta?: RecordingMeta,
    ) {}

    public static normalizeId(raw?: string | null): string | undefined {
        if (typeof raw !== 'string') {
            return undefined;
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            return undefined;
        }
        if (trimmed === 'true' || trimmed === '1') {
            return this.createId();
        }
        return trimmed.replace(this.ID_SAFE_RE, '_');
    }

    public static createId(): string {
        return `session-${Date.now()}`;
    }

    public capture(data: WsData): void {
        const at = this.getElapsed();
        const { payload, isBinary } = ActionRecorder.encode(data);
        this.messages.push({
            at,
            data: payload,
            binary: isBinary,
        });
    }

    public pause(): void {
        if (this.pausedAt) {
            return;
        }
        this.pausedAt = Date.now();
    }

    public resume(): void {
        if (!this.pausedAt) {
            return;
        }
        this.pausedDuration += Date.now() - this.pausedAt;
        this.pausedAt = undefined;
    }

    public async persist(): Promise<string> {
        const dir = ActionRecorder.ROOT_DIR;
        await fs.promises.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${this.id}.json`);
        const recording: RecordingFile = {
            id: this.id,
            remote: this.remote,
            createdAt: new Date(this.startedAt).toISOString(),
            name: this.meta?.name,
            meta: this.meta,
            messages: [...this.messages],
        };
        await fs.promises.writeFile(filePath, JSON.stringify(recording, null, 2), 'utf8');
        return filePath;
    }

    public static async load(id: string): Promise<RecordingFile> {
        const safeId = this.normalizeId(id);
        if (!safeId) {
            throw new Error('Recording id is required');
        }
        const filePath = path.join(this.ROOT_DIR, `${safeId}.json`);
        const content = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (!parsed || !Array.isArray(parsed.messages)) {
            throw new Error('Invalid recording file');
        }
        const messages: RecordedMessage[] = parsed.messages
            .map((item: any) => ({
                at: Number(item.at) || 0,
                data: String(item.data ?? ''),
                binary: Boolean(item.binary),
            }))
            .sort((a: RecordedMessage, b: RecordedMessage) => a.at - b.at);
        return {
            id: parsed.id || safeId,
            remote: parsed.remote,
            createdAt: parsed.createdAt,
            meta: parsed.meta,
            messages,
        };
    }

    public static decodeMessage(message: RecordedMessage): WsData {
        if (message.binary) {
            return Buffer.from(message.data, 'base64');
        }
        return message.data;
    }

    private static encode(data: WsData): { payload: string; isBinary: boolean } {
        if (typeof data === 'string') {
            return { payload: data, isBinary: false };
        }
        if (Buffer.isBuffer(data)) {
            return { payload: data.toString('base64'), isBinary: true };
        }
        if (Array.isArray(data)) {
            return { payload: Buffer.concat(data).toString('base64'), isBinary: true };
        }
        if (data instanceof ArrayBuffer) {
            return { payload: Buffer.from(data).toString('base64'), isBinary: true };
        }
        return { payload: String(data), isBinary: false };
    }

    private getElapsed(): number {
        const pausedDelta = this.pausedAt ? Date.now() - this.pausedAt : 0;
        return Date.now() - this.startedAt - this.pausedDuration - pausedDelta;
    }
}
