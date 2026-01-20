import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import type { Data as WsData } from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { DeviceSocketLogService } from '../services/DeviceSocketLogService';
import { ActionRecorder, RecordingFile } from '../services/ActionRecorder';
import { RecordingState, RecordingStatusService } from '../services/RecordingStatusService';
import { SyncService } from '../services/SyncService';

type WebsocketProxyLogMeta = {
    device?: string;
    source?: string;
};

type WebsocketProxyOptions = WebsocketProxyLogMeta & {
    logMeta?: WebsocketProxyLogMeta;
    recordId?: string;
    replayId?: string;
    session?: string;
};

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    private static sessions: Map<string, WebsocketProxy> = new Map();
    private remoteSocket?: WS;
    private released = false;
    private storage: WsData[] = [];
    private readonly logMeta?: WebsocketProxyLogMeta;
    private readonly recordId?: string;
    private readonly replayId?: string;
    private readonly sessionId?: string;
    private activeRecordId?: string;
    private playbackFinishTimer?: ReturnType<typeof setTimeout>;
    private playbackStart?: number;
    private playbackElapsed = 0;
    private recordingPaused = false;
    private playbackPaused = false;
    private remoteUrl?: string;
    private recorder?: ActionRecorder;
    private playback?: RecordingFile;
    private playbackTimers: Array<ReturnType<typeof setTimeout>> = [];
    private currentState: RecordingState = 'stop';

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_WS) {
            return;
        }
        const wsString = url.searchParams.get('ws');
        if (!wsString) {
            ws.close(4003, `[${this.TAG}] Invalid value "${ws}" for "ws" parameter`);
            return;
        }
        const recordParam = url.searchParams.has('record') ? url.searchParams.get('record') || 'true' : undefined;
        const replayParam = url.searchParams.has('replay') ? url.searchParams.get('replay') || undefined : undefined;
        const recordId = ActionRecorder.normalizeId(recordParam);
        const replayId = ActionRecorder.normalizeId(replayParam);
        const sessionId = url.searchParams.get('session') || undefined;
        if (url.searchParams.has('replay') && !replayId) {
            ws.close(4003, `[${this.TAG}] Invalid value "${replayParam}" for "replay" parameter`);
            return;
        }
        return this.createProxy(ws, wsString, { recordId, replayId, session: sessionId });
    }

    public static createProxy(
        ws: WS | Multiplexer,
        remoteUrl: string,
        options?: WebsocketProxyOptions,
    ): WebsocketProxy {
        const service = new WebsocketProxy(ws, options);
        service.init(remoteUrl).catch((e) => {
            const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
            console.error(msg);
            ws.close(4005, msg);
        });
        return service;
    }

    constructor(ws: WS | Multiplexer, options?: WebsocketProxyOptions) {
        super(ws);
        const { logMeta, recordId, replayId, session, ...maybeLogMeta } = options || {};
        this.logMeta = logMeta || (Object.keys(maybeLogMeta).length ? (maybeLogMeta as WebsocketProxyLogMeta) : undefined);
        this.recordId = recordId || undefined;
        this.replayId = replayId || undefined;
        this.sessionId = session || this.logMeta?.device || undefined;
        if (this.sessionId) {
            WebsocketProxy.sessions.set(this.sessionId, this);
        }
    }

    public async init(remoteUrl: string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${remoteUrl}}]`;
        this.remoteUrl = remoteUrl;
        this.updateStatus('stop');
        if (this.recordId) {
            this.recorder = new ActionRecorder(this.recordId, remoteUrl, this.logMeta);
            this.activeRecordId = this.recordId;
            this.updateStatus('record', this.recordId);
        }
        if (this.replayId) {
            this.playback = await ActionRecorder.load(this.replayId);
        }
        const remoteSocket = new WS(remoteUrl);
        remoteSocket.onopen = () => {
            this.remoteSocket = remoteSocket;
            this.flush();
            this.startPlayback();
        };
        remoteSocket.onmessage = (event) => {
            if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
                return;
            }
            const payload = event.data as any;
            if (Array.isArray(payload)) {
                payload.forEach((data) => this.ws.send(data));
                return;
            }
            // Forward binary frames as-is to avoid encoding/decoding overhead
            if (Buffer.isBuffer(payload) || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
                this.ws.send(payload);
            } else {
                this.ws.send(payload);
            }
        };
        remoteSocket.onclose = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(e.wasClean ? 1000 : 4010);
            }
        };
        remoteSocket.onerror = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(4011, e.message);
            }
        };
    }

    private flush(): void {
        if (this.remoteSocket) {
            while (this.storage.length) {
                const data = this.storage.shift();
                if (typeof data !== 'undefined') {
                    this.remoteSocket.send(data);
                }
            }
            if (this.released) {
                this.remoteSocket.close();
            }
        }
        this.storage.length = 0;
    }

    public release(): void {
        if (this.released) {
            return;
        }
        super.release();
        this.released = true;
        this.stopPlayback();
        void this.persistRecording();
        this.flush();
        if (this.sessionId) {
            WebsocketProxy.sessions.delete(this.sessionId);
            RecordingStatusService.getInstance().clearDevice(this.sessionId);
            SyncService.getInstance().clear();
        }
    }

    private startPlayback(playback?: RecordingFile): void {
        const targetPlayback = playback || this.playback;
        if (!targetPlayback || !this.remoteSocket || this.remoteSocket.readyState !== this.remoteSocket.OPEN) {
            return;
        }
        this.playbackElapsed = 0;
        this.playbackPaused = false;
        this.playback = targetPlayback;
        this.schedulePlayback(targetPlayback, 0);
    }

    private stopPlayback(resetProgress = true): void {
        this.playbackTimers.forEach((timer) => clearTimeout(timer));
        this.playbackTimers.length = 0;
        if (this.playbackFinishTimer) {
            clearTimeout(this.playbackFinishTimer);
            this.playbackFinishTimer = undefined;
        }
        this.playbackStart = undefined;
        if (resetProgress) {
            this.playbackPaused = false;
            this.playbackElapsed = 0;
        }
    }

    private async persistRecording(): Promise<void> {
        if (!this.recorder) {
            return;
        }
        try {
            const filePath = await this.recorder.persist();
            console.log(`[${WebsocketProxy.TAG}] Recorded actions saved to ${filePath}`);
        } catch (error: any) {
            console.error(`[${WebsocketProxy.TAG}] Failed to save recording: ${error?.message || error}`);
        }
    }

    public static getBySession(sessionId: string): WebsocketProxy | undefined {
        return this.sessions.get(sessionId);
    }

    public startRecording(recordId?: string): string {
        if (!this.remoteUrl) {
            throw new Error('Cannot start recording before proxy initialization');
        }
        if (this.currentState !== 'stop') {
            throw new Error('Device is busy; stop current action before starting a new recording');
        }
        if (this.recorder) {
            // replace ongoing recording with a new one
            this.persistRecording().catch((e) =>
                console.error(`[${WebsocketProxy.TAG}] Failed to persist existing recording: ${e?.message || e}`),
            );
        }
        const resolvedId = ActionRecorder.normalizeId(recordId) || ActionRecorder.createId();
        this.recorder = new ActionRecorder(resolvedId, this.remoteUrl, this.logMeta);
        this.activeRecordId = resolvedId;
        this.updateStatus('record', resolvedId);
        this.recordingPaused = false;
        return resolvedId;
    }

    public async stopRecording(): Promise<string | undefined> {
        if (!this.recorder) {
            throw new Error('Nothing to stop');
        }
        if (this.currentState !== 'record' && this.currentState !== 'pause') {
            throw new Error('Recording is not active');
        }
        const recorder = this.recorder;
        this.recorder = undefined;
        this.recordingPaused = false;
        const filePath = await recorder.persist();
        const lastRecordId = this.activeRecordId;
        this.activeRecordId = undefined;
        this.updateStatus('stop', lastRecordId, filePath);
        return filePath;
    }

    public async stop(): Promise<{ mode: 'record' | 'run' | null; filePath?: string }> {
        if (this.recorder) {
            const filePath = await this.stopRecording();
            return { mode: 'record', filePath };
        }
        if (this.playback) {
            const playbackId = this.playback.id;
            this.stopPlayback();
            this.playback = undefined;
            this.updateStatus('stop', playbackId);
            return { mode: 'run' };
        }
        throw new Error('Nothing to stop');
    }

    public async runRecording(recordId: string): Promise<void> {
        if (!recordId) {
            throw new Error('recordId is required');
        }
        if (this.currentState !== 'stop') {
            throw new Error('Device is busy; stop current action before running');
        }
        const recording = await ActionRecorder.load(recordId);
        this.stopPlayback();
        this.updateStatus('run', recording.id);
        this.startPlayback(recording);
    }

    public pause(): 'record' | 'run' {
        if (this.currentState === 'pause') {
            throw new Error('Already paused');
        }
        if (this.currentState === 'stop') {
            throw new Error('Nothing to pause');
        }
        if (this.recorder && !this.recordingPaused) {
            this.recordingPaused = true;
            this.recorder.pause();
            this.updateStatus('pause', this.activeRecordId);
            return 'record';
        }
        if (this.playback && !this.playbackPaused) {
            this.pausePlayback();
            return 'run';
        }
        throw new Error('Nothing to pause');
    }

    public resume(): 'record' | 'run' {
        if (this.currentState !== 'pause') {
            throw new Error('Cannot resume when not paused');
        }
        if (this.recorder && this.recordingPaused) {
            this.recordingPaused = false;
            this.recorder.resume();
            this.updateStatus('record', this.activeRecordId);
            return 'record';
        }
        if (this.playback && this.playbackPaused) {
            this.resumePlayback();
            return 'run';
        }
        throw new Error('Nothing to resume');
    }

    private pausePlayback(): void {
        if (!this.playback || this.playbackPaused) {
            return;
        }
        if (this.playbackStart) {
            this.playbackElapsed += Date.now() - this.playbackStart;
        }
        this.stopPlayback(false);
        this.playbackPaused = true;
        this.updateStatus('pause', this.playback.id);
    }

    private resumePlayback(): void {
        if (!this.playback || !this.playbackPaused || !this.remoteSocket || this.remoteSocket.readyState !== this.remoteSocket.OPEN) {
            return;
        }
        this.playbackPaused = false;
        this.schedulePlayback(this.playback, this.playbackElapsed);
    }

    private schedulePlayback(playback: RecordingFile, offsetMs: number): void {
        this.stopPlayback();
        this.playback = playback;
        this.playbackStart = Date.now();
        this.updateStatus('run', playback.id, undefined, offsetMs);
        playback.messages.forEach((message) => {
            if (message.at < offsetMs) {
                return;
            }
            const delay = Math.max(0, message.at - offsetMs);
            const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
                if (!this.remoteSocket || this.remoteSocket.readyState !== this.remoteSocket.OPEN) {
                    return;
                }
                try {
                    const payload = ActionRecorder.decodeMessage(message);
                    this.remoteSocket.send(payload);
                } catch (error: any) {
                    console.error(`[${WebsocketProxy.TAG}] Failed to replay message: ${error?.message || error}`);
                }
            }, delay);
            this.playbackTimers.push(timer);
        });
    }

    private updateStatus(state: 'record' | 'run' | 'stop' | 'pause', recordId?: string, filePath?: string, offsetMs = 0): void {
        this.currentState = state;
        if (!this.sessionId) {
            return;
        }
        RecordingStatusService.getInstance().setStatus({
            device: this.sessionId,
            status: state,
            recordId,
            filePath,
            remote: this.remoteUrl,
        });
        if (state === 'run' && this.playback) {
            const last = this.playback.messages[this.playback.messages.length - 1];
            const finishMs = Math.max(0, (last?.at || 0) - offsetMs + 200);
            if (finishMs > 0) {
                this.playbackFinishTimer = setTimeout(() => {
                    this.updateStatus('stop', recordId);
                }, finishMs);
            }
        }
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.logMeta?.device) {
            DeviceSocketLogService.log({
                device: this.logMeta.device,
                source: this.logMeta.source || WebsocketProxy.TAG,
                data: event.data,
            });
        }
        if (!this.recordingPaused) {
            this.recorder?.capture(event.data);
        }
        if (this.remoteSocket) {
            this.remoteSocket.send(event.data);
        } else {
            this.storage.push(event.data);
        }
        if (this.sessionId) {
            SyncService.getInstance().mirror(this.sessionId, event.data);
        }
    }

    public forwardFromSync(data: WsData): void {
        if (this.remoteSocket) {
            this.remoteSocket.send(data);
        } else {
            this.storage.push(data);
        }
    }
}
