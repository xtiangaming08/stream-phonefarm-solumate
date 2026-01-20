import { TypedEmitter } from '../../common/TypedEmitter';

export type RecordingState = 'record' | 'run' | 'stop' | 'pause';

export type RecordingStatus = {
    device: string;
    status: RecordingState;
    recordId?: string;
    filePath?: string;
    remote?: string;
    updatedAt: number;
};

export type PublicRecordingStatus = { device: string; status: RecordingState };

type RecordingStatusEvents = {
    snapshot: PublicRecordingStatus[];
};

export class RecordingStatusService extends TypedEmitter<RecordingStatusEvents> {
    private static instance?: RecordingStatusService;
    private statuses: Map<string, RecordingStatus> = new Map();

    private constructor() {
        super();
    }

    public static getInstance(): RecordingStatusService {
        if (!this.instance) {
            this.instance = new RecordingStatusService();
        }
        return this.instance;
    }

    public setStatus(status: Omit<RecordingStatus, 'updatedAt'>): RecordingStatus {
        const fullStatus: RecordingStatus = {
            ...status,
            updatedAt: Date.now(),
        };
        this.statuses.set(fullStatus.device, fullStatus);
        this.emit('snapshot', this.getPublicSnapshot());
        return fullStatus;
    }

    public clearDevice(device: string): void {
        if (this.statuses.has(device)) {
            this.statuses.delete(device);
            this.emit('snapshot', this.getPublicSnapshot());
        }
    }

    public getAll(): RecordingStatus[] {
        return Array.from(this.statuses.values());
    }

    public getPublicSnapshot(): PublicRecordingStatus[] {
        return this.getAll().map(({ device, status }) => ({ device, status }));
    }
}
