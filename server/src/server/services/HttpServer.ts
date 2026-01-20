import * as http from 'http';
import * as https from 'https';
import path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { Service } from './Service';
import { Utils } from '../Utils';
import express, { Express } from 'express';
import { Config } from '../Config';
import { TypedEmitter } from '../../common/TypedEmitter';
import * as process from 'process';
import { EnvName } from '../EnvName';
import { WebsocketProxy } from '../mw/WebsocketProxy';
import { ActionRecorder } from './ActionRecorder';
import { RecordingRepository } from './RecordingRepository';
import { SyncService } from './SyncService';
import { promisify } from 'util';
import { DeviceListSocket } from '../mw/DeviceListSocket';
import { ConnectPreferenceService, ConnectType } from './ConnectPreferenceService';
import { KeepAwakeService } from './KeepAwakeService';
/// #if INCLUDE_GOOG
import { ControlCenter as GoogControlCenter } from '../goog-device/services/ControlCenter';
import VideoSettings from '../../common/VideoSettings';
import { AdbUtils } from '../goog-device/AdbUtils';
import WS from 'ws';
/// #endif

const DEFAULT_STATIC_DIR = path.join(__dirname, './public');
const execFileAsync = promisify(execFile);

const PATHNAME = process.env[EnvName.WS_SCRCPY_PATHNAME] || __PATHNAME__;
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

async function runAdbInstall(udid: string, apkPath: string): Promise<string> {
    const execAdb = (args: string[], label: string): Promise<string> =>
        new Promise((resolve, reject) => {
            const proc = spawn('adb', ['-s', udid, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            const timeout = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`${label} timed out`));
            }, 120000);
            proc.stdout.on('data', (d) => (stdout += d.toString()));
            proc.stderr.on('data', (d) => (stderr += d.toString()));
            proc.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            proc.on('close', (code) => {
                clearTimeout(timeout);
                const out = (stdout + '\n' + stderr).trim();
                if (code === 0) {
                    resolve(out);
                } else {
                    reject(new Error(out || `${label} failed (code ${code ?? 'unknown'})`));
                }
            });
        });

    const ext = path.extname(apkPath).toLowerCase();
    if (ext === '.xapk' || ext === '.zip') {
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-scrcpy-xapk-'));
        try {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn('unzip', ['-o', '-q', apkPath, '-d', tmpDir], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stderr = '';
                proc.stderr.on('data', (d) => (stderr += d.toString()));
                proc.on('error', reject);
                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(stderr || `unzip failed (code ${code})`));
                    }
                });
            });
            const apkFiles: string[] = [];
            const walk = async (dir: string) => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(full);
                    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.apk')) {
                        apkFiles.push(full);
                    }
                }
            };
            await walk(tmpDir);
            if (!apkFiles.length) {
                throw new Error('No APK files found in xapk/zip');
            }
            apkFiles.sort((a, b) => {
                const al = path.basename(a).toLowerCase();
                const bl = path.basename(b).toLowerCase();
                const aBase = al.includes('base');
                const bBase = bl.includes('base');
                if (aBase !== bBase) return aBase ? -1 : 1;
                return al.localeCompare(bl);
            });
            const out = await execAdb(['install', '-r', ...apkFiles], 'adb install');
            if (out.toLowerCase().includes('success')) {
                return out || 'Success';
            }
            throw new Error(out || 'install failed');
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const remover = (fs.promises as any).rm ? (fs.promises as any).rm : fs.promises.rmdir;
            remover.call(fs.promises, tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    const remote = `/data/local/tmp/${path.basename(apkPath)}`;
    let pushed = false;
    try {
        await execAdb(['push', apkPath, remote], 'adb push');
        pushed = true;
        const out = await execAdb(['shell', 'pm', 'install', '-r', remote], 'pm install');
        if (out.toLowerCase().includes('success')) {
            return out || 'Success';
        }
        throw new Error(out || 'pm install failed');
    } finally {
        if (pushed) {
            execAdb(['shell', 'rm', remote], 'cleanup').catch(() => undefined);
        }
    }
}

async function runAdbCommand(args: string[], label: string): Promise<string> {
    try {
        const { stdout, stderr } = await execFileAsync('adb', args);
        const out = (stdout + '\n' + stderr).trim();
        return out;
    } catch (error: any) {
        const out = ((error?.stdout || '') + '\n' + (error?.stderr || '')).trim();
        const message = out || error?.message || `${label} failed`;
        throw new Error(message);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ServerAndPort = {
    server: https.Server | http.Server;
    port: number;
};

interface HttpServerEvents {
    started: boolean;
}

export class HttpServer extends TypedEmitter<HttpServerEvents> implements Service {
    private static instance: HttpServer;
    private static PUBLIC_DIR = DEFAULT_STATIC_DIR;
    private static SERVE_STATIC = true;
    private servers: ServerAndPort[] = [];
    private mainApp?: Express;
    private started = false;

    protected constructor() {
        super();
    }

    public static getInstance(): HttpServer {
        if (!this.instance) {
            this.instance = new HttpServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static setPublicDir(dir: string): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.PUBLIC_DIR = dir;
    }

    public static setServeStatic(enabled: boolean): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.SERVE_STATIC = enabled;
    }

    public async getServers(): Promise<ServerAndPort[]> {
        if (this.started) {
            return [...this.servers];
        }
        return new Promise<ServerAndPort[]>((resolve) => {
            this.once('started', () => {
                resolve([...this.servers]);
            });
        });
    }

    public getName(): string {
        return `HTTP(s) Server Service`;
    }

    public async start(): Promise<void> {
        this.mainApp = express();
        // Parse JSON bodies for API endpoints
        this.mainApp.use(express.json({ limit: '50mb' }));
        // Basic CORS for API usage from dev clients (e.g. Vite on localhost:5173)
        this.mainApp.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, X-UDID, X-Filename, X-File-Size');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(204);
            }
            next();
        });
        if (HttpServer.SERVE_STATIC && HttpServer.PUBLIC_DIR) {
            this.mainApp.use(PATHNAME, express.static(HttpServer.PUBLIC_DIR));

            /// #if USE_WDA_MJPEG_SERVER

            const { MjpegProxyFactory } = await import('../mw/MjpegProxyFactory');
            this.mainApp.get('/mjpeg/:udid', new MjpegProxyFactory().proxyRequest);
            /// #endif
        }
        /// #if INCLUDE_GOOG
        this.mainApp.post('/api/goog/device/pid', async (req, res) => {
            const { udid } = req.body || {};
            if (typeof udid !== 'string' || !udid) {
                return res.status(400).json({ success: false, error: 'Invalid "udid"' });
            }
            try {
                const controlCenter = GoogControlCenter.getInstance();
                const pid = await controlCenter.getDevicePid(udid, 5000);
                if (typeof pid !== 'number') {
                    return res.status(404).json({ success: false, error: 'Server PID not found' });
                }
                return res.json({ success: true, pid });
            } catch (error: any) {
                const message = error?.message || 'Failed to get device pid';
                return res.status(500).json({ success: false, error: message });
            }
        });
        this.mainApp.post('/api/goog/device/config', async (req, res) => {
            const { udid, videoSettings } = req.body || {};
            if (typeof udid !== 'string' || !udid) {
                return res.status(400).json({ success: false, error: 'Invalid "udid"' });
            }
            if (typeof videoSettings !== 'object' || videoSettings === null) {
                return res.status(400).json({ success: false, error: 'Invalid "videoSettings"' });
            }
            const { crop, bounds } = videoSettings;
            const validateRect = (rect: any) => {
                if (!rect) {
                    return null;
                }
                const required = ['left', 'top', 'right', 'bottom'];
                for (const key of required) {
                    if (typeof rect[key] !== 'number') {
                        throw new Error(`Invalid crop.${key}`);
                    }
                }
                return rect;
            };
            const validateSize = (size: any) => {
                if (!size) {
                    return null;
                }
                if (typeof size.width !== 'number' || typeof size.height !== 'number') {
                    throw new Error('Invalid bounds (width/height)');
                }
                return size;
            };
            try {
                const controlCenter = GoogControlCenter.getInstance();
                const normalized = {
                    ...videoSettings,
                    crop: validateRect(crop),
                    bounds: validateSize(bounds),
                };
                const settings: VideoSettings = controlCenter.setVideoSettings(udid, normalized);
                return res.json({ success: true, videoSettings: settings.toJSON() });
            } catch (error: any) {
                const message = error?.message || 'Failed to set video settings';
                return res.status(400).json({ success: false, error: message });
            }
        });
        this.mainApp.post('/api/goog/device/restart', async (req, res) => {
            const { udid, udids, pid } = req.body || {};
            const normalizedUdids = (Array.isArray(udids) ? udids : udid ? [udid] : [])
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean);
            if (!normalizedUdids.length) {
                return res.status(400).json({ success: false, error: 'Invalid "udids" or "udid"' });
            }
            // pid is optional; if missing/invalid, server will resolve current pid automatically
            const controlCenter = GoogControlCenter.getInstance();
            const results = await Promise.all(
                normalizedUdids.map(async (deviceUdid: string) => {
                    try {
                        const newPid = await controlCenter.restartDevice(deviceUdid, pid, 20000);
                        return { udid: deviceUdid, success: true, pid: newPid };
                    } catch (error: any) {
                        const message = error?.message || 'Failed to restart device';
                        return { udid: deviceUdid, success: false, error: message };
                    }
                }),
            );
            const allSuccess = results.every((item) => item.success);
            const response: Record<string, unknown> = { success: allSuccess, results };
            if (results.length === 1 && results[0].success) {
                response.pid = results[0].pid;
            }
            return res.status(allSuccess ? 200 : 207).json(response);
        });
        this.mainApp.post('/api/goog/device/send-binary', async (req, res) => {
            const { udid, udids, remote = 'tcp:8886', dataBase64, path: wsPath = '', timeoutMs = 5000 } = req.body || {};
            const targets = (Array.isArray(udids) ? udids : udid ? [udid] : [])
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean);
            if (!targets.length) {
                return res.status(400).json({ success: false, error: 'Invalid "udids" or "udid"' });
            }
            if (typeof remote !== 'string' || !remote) {
                return res.status(400).json({ success: false, error: 'Invalid "remote"' });
            }
            if (typeof dataBase64 !== 'string' || !dataBase64) {
                return res.status(400).json({ success: false, error: 'Invalid "dataBase64"' });
            }
            let buffer: Buffer;
            try {
                buffer = Buffer.from(dataBase64, 'base64');
                if (!buffer.length) {
                    throw new Error('Empty buffer');
                }
            } catch (error: any) {
                return res.status(400).json({ success: false, error: error?.message || 'Invalid base64' });
            }

            const timeoutValue = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 5000;
            const sendToDevice = async (deviceUdid: string) => {
                try {
                    const port = await AdbUtils.forward(deviceUdid, remote);
                    const url = `ws://127.0.0.1:${port}${wsPath || ''}`;
                    await new Promise<void>((resolve, reject) => {
                        const ws = new WS(url);
                        const timer = setTimeout(() => {
                            ws.terminate();
                            reject(new Error('Timed out waiting for websocket'));
                        }, timeoutValue);
                        ws.on('open', () => {
                            ws.send(buffer, { binary: true }, (err) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                ws.close();
                            });
                        });
                        ws.on('error', (e) => {
                            clearTimeout(timer);
                            reject(e);
                        });
                        ws.on('close', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                    });
                    return { udid: deviceUdid, success: true };
                } catch (error: any) {
                    const message = error?.message || 'Failed to send data';
                    return { udid: deviceUdid, success: false, error: message };
                }
            };

            const results = await Promise.all(targets.map((deviceUdid) => sendToDevice(deviceUdid)));
            const allSuccess = results.every((r) => r.success);
            return res.status(allSuccess ? 200 : 207).json({ success: allSuccess, results });
        });
        this.mainApp.post('/api/goog/device/install-apk', async (req, res) => {
            const { udid, dataBase64, fileName } = req.body || {};
            if (typeof udid !== 'string' || !udid.trim()) {
                return res.status(400).json({ success: false, error: 'Invalid "udid"' });
            }
            if (typeof dataBase64 !== 'string' || !dataBase64) {
                return res.status(400).json({ success: false, error: 'Invalid "dataBase64"' });
            }
            const safeName =
                typeof fileName === 'string' && fileName.trim()
                    ? fileName.trim().replace(/[^a-zA-Z0-9_.-]/g, '_')
                    : 'upload.apk';
            let buffer: Buffer;
            try {
                buffer = Buffer.from(dataBase64, 'base64');
                if (!buffer.length) {
                    throw new Error('Empty buffer');
                }
            } catch (error: any) {
                return res.status(400).json({ success: false, error: error?.message || 'Invalid base64' });
            }
            const tmpPath = path.join(
                UPLOAD_DIR,
                `ws-scrcpy-upload-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`,
            );
            try {
                await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
                await fs.promises.writeFile(tmpPath, buffer);
                return res.json({ success: true, filePath: tmpPath });
            } catch (error: any) {
                const message = error?.message || 'Failed to save apk';
                return res.status(500).json({ success: false, error: message });
            }
        });
        this.mainApp.post(
            '/api/goog/device/install-apk-binary',
            express.raw({ limit: '200mb', type: '*/*' }),
            async (req, res) => {
                const udid = (req.header('x-udid') || req.query.udid || '').toString().trim();
                const fileNameHeader = (req.header('x-filename') || req.query.fileName || '').toString();
                const expectedSizeHeader = req.header('x-file-size');
                if (!udid) {
                    return res.status(400).json({ success: false, error: 'Invalid "udid"' });
                }
                const buffer = req.body as Buffer;
                if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
                    return res.status(400).json({ success: false, error: 'Empty apk payload' });
                }
                if (expectedSizeHeader) {
                    const expectedSize = parseInt(expectedSizeHeader.toString(), 10);
                    if (!isNaN(expectedSize) && expectedSize !== buffer.length) {
                        return res.status(400).json({
                            success: false,
                            error: `Size mismatch: got ${buffer.length}, expected ${expectedSize}`,
                        });
                    }
                }
                const safeName = fileNameHeader
                    ? fileNameHeader.trim().replace(/[^a-zA-Z0-9_.-]/g, '_')
                    : 'upload.apk';
                const tmpPath = path.join(
                    UPLOAD_DIR,
                    `ws-scrcpy-upload-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`,
                );
                try {
                    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
                    await fs.promises.writeFile(tmpPath, buffer);
                    const stat = await fs.promises.stat(tmpPath);
                    if (expectedSizeHeader) {
                        const expectedSize = parseInt(expectedSizeHeader.toString(), 10);
                        if (!isNaN(expectedSize) && expectedSize !== stat.size) {
                            throw new Error(`Size mismatch after write: got ${stat.size}, expected ${expectedSize}`);
                        }
                    }
                    return res.json({ success: true, filePath: tmpPath });
                } catch (error: any) {
                    const message = error?.message || 'Failed to save apk';
                    return res.status(500).json({ success: false, error: message });
                }
            },
        );
        this.mainApp.post('/api/goog/device/install-uploaded', async (req, res) => {
            const { udid, filePath } = req.body || {};
            if (typeof udid !== 'string' || !udid.trim()) {
                return res.status(400).json({ success: false, error: 'Invalid "udid"' });
            }
            if (typeof filePath !== 'string' || !filePath.trim()) {
                return res.status(400).json({ success: false, error: 'Invalid "filePath"' });
            }
            // Ensure path is inside UPLOAD_DIR
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(UPLOAD_DIR)) {
                return res.status(400).json({ success: false, error: 'filePath not allowed' });
            }
            if (!fs.existsSync(resolved)) {
                return res.status(404).json({ success: false, error: 'file not found' });
            }
            try {
                const output = await runAdbInstall(udid.trim(), resolved);
                return res.json({ success: true, output });
            } catch (error: any) {
                const message = error?.message || 'Failed to install uploaded file';
                return res.status(500).json({ success: false, error: message });
            }
        });
        /// #endif
        this.mainApp.post('/api/recordings/start', async (req, res) => {
            const { session, recordId } = req.body || {};
            if (typeof session !== 'string' || !session.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "session"' });
            }
            const proxy = WebsocketProxy.getBySession(session.trim());
            if (!proxy) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            try {
                const resolvedId = proxy.startRecording(recordId);
                return res.json({ success: true, recordId: resolvedId });
            } catch (error: any) {
                const message = error?.message || 'Failed to start recording';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/stop', async (req, res) => {
            const { session } = req.body || {};
            if (typeof session !== 'string' || !session.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "session"' });
            }
            const proxy = WebsocketProxy.getBySession(session.trim());
            if (!proxy) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            try {
                const result = await proxy.stop();
                return res.json({ success: true, ...result });
            } catch (error: any) {
                const message = error?.message || 'Failed to stop recording';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/run', async (req, res) => {
            const { session, recordId } = req.body || {};
            const resolvedId = ActionRecorder.normalizeId(recordId);
            if (typeof session !== 'string' || !session.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "session"' });
            }
            if (!resolvedId) {
                return res.status(400).json({ success: false, message: 'Invalid "recordId"' });
            }
            const proxy = WebsocketProxy.getBySession(session.trim());
            if (!proxy) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            try {
                await proxy.runRecording(resolvedId);
                return res.json({ success: true });
            } catch (error: any) {
                const message = error?.message || 'Failed to run recording';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/pause', async (req, res) => {
            const { session } = req.body || {};
            if (typeof session !== 'string' || !session.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "session"' });
            }
            const proxy = WebsocketProxy.getBySession(session.trim());
            if (!proxy) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            try {
                const mode = proxy.pause();
                return res.json({ success: true, mode });
            } catch (error: any) {
                const message = error?.message || 'Failed to pause';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/resume', async (req, res) => {
            const { session } = req.body || {};
            if (typeof session !== 'string' || !session.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "session"' });
            }
            const proxy = WebsocketProxy.getBySession(session.trim());
            if (!proxy) {
                return res.status(404).json({ success: false, message: 'Session not found' });
            }
            try {
                const mode = proxy.resume();
                return res.json({ success: true, mode });
            } catch (error: any) {
                const message = error?.message || 'Failed to resume';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/devices/connect', async (req, res) => {
            const payloads = Array.isArray(req.body) ? req.body : [req.body];
            if (!payloads.length) {
                return res.status(400).json({ success: false, error: 'Empty payload' });
            }
            const preferenceService = ConnectPreferenceService.getInstance();
            const resolveUuid = async (dev: string): Promise<string | undefined> => {
                if (dev.includes(':')) {
                    return DeviceListSocket.getSerial(dev);
                }
                return dev;
            };

            const processItem = async (
                item: any,
            ): Promise<{ device: string; connect?: string; success: boolean; error?: string }> => {
                const { device, connect, port: portRaw } = item || {};
                const connectType: ConnectType | undefined =
                    connect === 'wifi' ? 'wifi' : connect === 'usb' ? 'usb' : undefined;
                const deviceStr = typeof device === 'string' ? device.trim() : '';
                const portFromBody = typeof portRaw === 'number' && portRaw > 0 ? portRaw : undefined;
                if (!deviceStr || !connectType) {
                    return {
                        device: deviceStr || '',
                        connect,
                        success: false,
                        error: 'Invalid "device" or "connect"',
                    };
                }
                try {
                    if (connectType === 'usb') {
                        const uuid = await resolveUuid(deviceStr);
                        if (!uuid) {
                            throw new Error('Unable to resolve device uuid');
                        }
                        await execFileAsync('adb', ['-s', uuid, 'usb']);
                        const currentDevices = await DeviceListSocket.collectDevices();
                        const wifiPeers = currentDevices.filter(
                            (d) => d.uuid === uuid && d.connect_type === 'wifi' && d.device.includes(':'),
                        );
                        await Promise.all(
                            wifiPeers.map((peer) => execFileAsync('adb', ['disconnect', peer.device]).catch(() => undefined)),
                        );
                        if (deviceStr.includes(':')) {
                            await execFileAsync('adb', ['disconnect', deviceStr]).catch(() => undefined);
                        }
                        preferenceService.setPreference(uuid, 'usb');
                    } else {
                        const portFromDevice =
                            deviceStr.includes(':') && deviceStr.split(':')[1]
                                ? parseInt(deviceStr.split(':')[1], 10) || undefined
                                : undefined;
                        const targetPort = portFromBody ?? portFromDevice ?? 5555;
                        const uuid = deviceStr.includes(':') ? await resolveUuid(deviceStr) : deviceStr;
                        if (!uuid) {
                            throw new Error('Unable to resolve device uuid');
                        }
                        const hostPart = deviceStr.includes(':') ? deviceStr.split(':')[0] : '';
                        let target = '';
                        if (hostPart) {
                            target = `${hostPart}:${targetPort}`;
                        } else {
                            const ip = await DeviceListSocket.getDeviceIp(uuid);
                            if (!ip) {
                                throw new Error('Unable to resolve device ip');
                            }
                            target = `${ip}:${targetPort}`;
                        }
                        const connectOverWifi = async () => {
                            await runAdbCommand(['-s', uuid, 'tcpip', `${targetPort}`], 'adb tcpip');
                            await delay(400);
                            let connected = false;
                            let lastError: string | undefined;
                            for (let i = 0; i < 3 && !connected; i++) {
                                try {
                                    const out = await runAdbCommand(['connect', target], 'adb connect');
                                    lastError = out;
                                    if (
                                        out.toLowerCase().includes('connected to') ||
                                        out.toLowerCase().includes('already connected')
                                    ) {
                                        connected = true;
                                        break;
                                    }
                                } catch (err: any) {
                                    lastError = err?.message;
                                }
                                await delay(400);
                            }
                            if (!connected) {
                                throw new Error(lastError || 'Failed to connect over WiFi');
                            }
                        };
                        const TIMEOUT_MS = 10000;
                        let timeoutId: ReturnType<typeof setTimeout> | undefined;
                        try {
                            await Promise.race([
                                connectOverWifi(),
                                new Promise<void>((_, reject) => {
                                    timeoutId = setTimeout(() => {
                                        reject(new Error('WiFi connection timed out after 10 seconds'));
                                    }, TIMEOUT_MS);
                                }),
                            ]);
                        } finally {
                            if (timeoutId) {
                                clearTimeout(timeoutId);
                            }
                        }
                        preferenceService.setPreference(uuid, 'wifi');
                    }
                    return { device: deviceStr, connect: connectType, success: true };
                } catch (error: any) {
                    return {
                        device: deviceStr,
                        connect: connectType,
                        success: false,
                        error: error?.message || 'Failed to switch connection',
                    };
                }
            };

            const results = await Promise.all(payloads.map((p) => processItem(p)));
            const devices = await DeviceListSocket.collectDevices();
            const allSuccess = results.every((r) => r.success);
            return res.json({ success: allSuccess, results, devices });
        });
        this.mainApp.post('/api/device/keep-awake', async (req, res) => {
            const { device, seconds } = req.body || {};
            const deviceStr = typeof device === 'string' ? device.trim() : '';
            if (!deviceStr) {
                return res.status(400).json({ success: false, error: 'Invalid "device"' });
            }
            const durationMs = typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : 30000;
            try {
                await KeepAwakeService.getInstance().keepAwake(deviceStr, durationMs);
                return res.json({ success: true, device: deviceStr, durationMs });
            } catch (error: any) {
                const message = error?.message || 'Failed to keep screen awake';
                return res.status(500).json({ success: false, error: message });
            }
        });
        this.mainApp.get('/api/recordings', async (_req, res) => {
            try {
                const records = await RecordingRepository.list();
                return res.json({ success: true, records });
            } catch (error: any) {
                const message = error?.message || 'Failed to list recordings';
                return res.status(500).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/update-name', async (req, res) => {
            const { recordId, name } = req.body || {};
            if (typeof recordId !== 'string' || !recordId.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "recordId"' });
            }
            if (typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "name"' });
            }
            try {
                await RecordingRepository.updateName(recordId, name.trim());
                return res.json({ success: true });
            } catch (error: any) {
                const message = error?.message || 'Failed to update recording name';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/recordings/delete', async (req, res) => {
            const { recordId } = req.body || {};
            if (typeof recordId !== 'string' || !recordId.trim()) {
                return res.status(400).json({ success: false, message: 'Invalid "recordId"' });
            }
            try {
                await RecordingRepository.delete(recordId.trim());
                return res.json({ success: true });
            } catch (error: any) {
                const message = error?.message || 'Failed to delete recording';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.get('/api/sync', async (_req, res) => {
            try {
                const sync = SyncService.getInstance().list();
                return res.json({ success: true, sync });
            } catch (error: any) {
                const message = error?.message || 'Failed to list sync mapping';
                return res.status(500).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/sync/set', async (req, res) => {
            const { target_device: targetDevice, sync_devices: syncDevices } = req.body || {};
            const targetList = Array.isArray(targetDevice) ? targetDevice : [targetDevice];
            const normalizedTargets = targetList
                .map((t) => (typeof t === 'string' ? t.trim() : ''))
                .filter(Boolean);
            if (!normalizedTargets.length) {
                return res.status(400).json({ success: false, message: 'Invalid "target_device"' });
            }
            if (!Array.isArray(syncDevices)) {
                return res.status(400).json({ success: false, message: 'Invalid "sync_devices"' });
            }
            const normalized = syncDevices.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean);
            try {
                const sync = SyncService.getInstance().setMapping(normalizedTargets, normalized);
                return res.json({ success: true, sync });
            } catch (error: any) {
                const message = error?.message || 'Failed to set sync mapping';
                return res.status(400).json({ success: false, message });
            }
        });
        this.mainApp.post('/api/sync/clear', async (req, res) => {
            try {
                SyncService.getInstance().clear();
                return res.json({ success: true });
            } catch (error: any) {
                const message = error?.message || 'Failed to clear sync mapping';
                return res.status(400).json({ success: false, message });
            }
        });
        const config = Config.getInstance();
        config.servers.forEach((serverItem) => {
            const { secure, port, redirectToSecure } = serverItem;
            let proto: string;
            let server: http.Server | https.Server;
            if (secure) {
                if (!serverItem.options) {
                    throw Error('Must provide option for secure server configuration');
                }
                server = https.createServer(serverItem.options, this.mainApp);
                proto = 'https';
            } else {
                const options = serverItem.options ? { ...serverItem.options } : {};
                proto = 'http';
                let currentApp = this.mainApp;
                let host = '';
                let port = 443;
                let doRedirect = false;
                if (redirectToSecure === true) {
                    doRedirect = true;
                } else if (typeof redirectToSecure === 'object') {
                    doRedirect = true;
                    if (typeof redirectToSecure.port === 'number') {
                        port = redirectToSecure.port;
                    }
                    if (typeof redirectToSecure.host === 'string') {
                        host = redirectToSecure.host;
                    }
                }
                if (doRedirect) {
                    currentApp = express();
                    currentApp.use(function (req, res) {
                        const url = new URL(`https://${host ? host : req.headers.host}${req.url}`);
                        if (port && port !== 443) {
                            url.port = port.toString();
                        }
                        return res.redirect(301, url.toString());
                    });
                }
                server = http.createServer(options, currentApp);
            }
            this.servers.push({ server, port });
            server.listen(port, () => {
                Utils.printListeningMsg(proto, port, PATHNAME);
            });
        });
        this.started = true;
        this.emit('started', true);
    }

    public release(): void {
        this.servers.forEach((item) => {
            item.server.close();
        });
    }
}
