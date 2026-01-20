import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { RecordingStatusService, RecordingState } from '../services/RecordingStatusService';

type PublicStatus = { device: string; status: RecordingState };
type StatusPayload = { type: 'snapshot'; statuses: PublicStatus[] };

export class RecordingStatusSocket extends Mw {
    public static readonly TAG = 'RecordingStatusSocket';
    private readonly statusService = RecordingStatusService.getInstance();
    private readonly onSnapshot = (statuses: PublicStatus[]) => this.send({ type: 'snapshot', statuses });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static processRequest(ws: WS, params: RequestParameters): RecordingStatusSocket | undefined {
        const { action } = params;
        if (action !== ACTION.RECORD_STATUS) {
            return;
        }
        return new RecordingStatusSocket(ws);
    }

    constructor(ws: WS) {
        super(ws);
        this.send({ type: 'snapshot', statuses: this.statusService.getPublicSnapshot() });
        this.statusService.on('snapshot', this.onSnapshot);
    }

    protected onSocketMessage(_event: WS.MessageEvent): void {
        // read-only
    }

    private send(payload: StatusPayload): void {
        if (this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        this.ws.send(JSON.stringify(payload));
    }

    public release(): void {
        this.statusService.off('snapshot', this.onSnapshot);
        super.release();
    }
}
