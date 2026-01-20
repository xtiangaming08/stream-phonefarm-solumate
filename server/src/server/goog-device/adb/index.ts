import Adb from '@dead50f7/adbkit/lib/adb';
import { ExtendedClient } from './ExtendedClient';
import { ClientOptions } from '@dead50f7/adbkit/lib/ClientOptions';

interface Options {
    host?: string;
    port?: number;
    bin?: string;
}

export class AdbExtended extends Adb {
    private static clientCache: Map<string, ExtendedClient> = new Map();
    static createClient(options: Options = {}): ExtendedClient {
        const opts: ClientOptions = {
            bin: options.bin,
            host: options.host || process.env.ADB_HOST || '127.0.0.1',
            port: options.port || 0,
        };
        if (!opts.port) {
            const port = parseInt(process.env.ADB_PORT || '', 10);
            if (!isNaN(port)) {
                opts.port = port;
            } else {
                opts.port = 5037;
            }
        }
        const cacheKey = `${opts.host}:${opts.port}:${opts.bin || ''}`;
        const cached = this.clientCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const client = new ExtendedClient(opts);
        this.clientCache.set(cacheKey, client);
        client.on('end', () => {
            this.clientCache.delete(cacheKey);
        });
        client.on('error', () => {
            this.clientCache.delete(cacheKey);
        });
        return client;
    }
}
