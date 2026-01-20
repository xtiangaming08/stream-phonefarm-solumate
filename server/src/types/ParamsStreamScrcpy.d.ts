import { ACTION } from '../common/Action';
import { ParamsStream } from './ParamsStream';
import VideoSettings from '../common/VideoSettings';

export interface ParamsStreamScrcpy extends ParamsStream {
    action: ACTION.STREAM_SCRCPY;
    ws: string;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
}
