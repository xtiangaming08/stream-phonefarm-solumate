export type DeviceSocketLogContext = {
    device: string;
    source?: string;
    data: unknown;
};

export class DeviceSocketLogService {
    private static readonly TAG = 'DeviceSocketLogService';
    private static readonly ENABLE_FULL_PAYLOAD = !!process.env.DEVICE_SOCKET_LOG_PAYLOAD;

    public static log(ctx: DeviceSocketLogContext): void {
        const { device, data, source } = ctx;
        const payload: Record<string, unknown> = { device };
        if (source) {
            payload.source = source;
        }
        try {
            if (DeviceSocketLogService.ENABLE_FULL_PAYLOAD) {
                payload.data = DeviceSocketLogService.serialize(data);
            } else {
                // avoid heavy serialization of binary frames: log concise metadata
                if (Buffer.isBuffer(data)) {
                    payload.data = { type: 'Buffer', length: data.length };
                } else if (ArrayBuffer.isView(data)) {
                    payload.data = { type: 'ArrayBufferView', length: data.byteLength };
                } else if (data instanceof ArrayBuffer) {
                    payload.data = { type: 'ArrayBuffer', length: data.byteLength };
                } else if (typeof data === 'string') {
                    payload.data = { type: 'string', length: data.length };
                } else {
                    payload.data = data;
                }
            }
        } catch (error: any) {
            payload.data = `<unserializable: ${error?.message || 'unknown error'}>`;
        }
        console.log(`[${DeviceSocketLogService.TAG}] ${JSON.stringify(payload)}`);
    }

    private static serialize(data: unknown): unknown {
        if (Buffer.isBuffer(data)) {
            return `base64:${data.toString('base64')}`;
        }
        if (ArrayBuffer.isView(data)) {
            return `base64:${Buffer.from(data.buffer).toString('base64')}`;
        }
        if (data instanceof ArrayBuffer) {
            return `base64:${Buffer.from(data).toString('base64')}`;
        }
        return data;
    }
}
