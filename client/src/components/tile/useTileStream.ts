import { useEffect, useRef, type MutableRefObject } from 'react';
import { attachTouchControls } from '@/lib/touchControls';
import { AnnexBSplitter, buildConfigBinary, makeWsUrl } from '@/lib/video';
import { useI18n } from '@/context/I18nContext';
import type { StreamConfig } from '@/lib/config';
import type { InputTarget } from '@/context/ActiveContext';

type Args = {
    udid: string;
    deviceParam: string | null;
    wsServer: string;

    // DOM refs
    canvasRef: MutableRefObject<HTMLCanvasElement | null>;
    bodyRef: MutableRefObject<HTMLDivElement | null>;
    frameRef: MutableRefObject<HTMLDivElement | null>;

    // WS + teardown refs
    wsRef: MutableRefObject<WebSocket | null>;
    reconnectTimerRef: MutableRefObject<number | null>;
    detachControlsRef: MutableRefObject<(() => void) | null>;
    closingRef: MutableRefObject<boolean>;
    destroyedRef: MutableRefObject<boolean>;

    // Keep latest config without re-running the heavy stream effect on every tick
    streamCfgRef: MutableRefObject<StreamConfig>;

    // Active/sync callbacks from ActiveContext
    selectOnly: (udid: string) => void;
    getInputTargetsForSource: (udid: string) => InputTarget[];

  // UI state setters
  setStatus: (s: string) => void;
  setLoading: (b: boolean) => void;

  // Exposed reload ref (used by header/menu + parent App for reload-all)
  reloadRef: MutableRefObject<(() => void) | null>;

  // Notify caller about current video dimensions (per-tile aspect ratio)
  onVideoDims?: (w: number, h: number) => void;
};

/**
 * Handles the *streaming pipeline* for a tile:
 * - WebSocket connect/reconnect
 * - tinyh264 decode worker
 * - YUV->ImageBitmap render worker
 * - canvas fit (ResizeObserver + viewport listeners)
 * - touch controls attachment
 *
 * Logic is moved from the original monolithic Tile.tsx WITHOUT changing behavior.
 */
export function useTileStream(args: Args) {
    const {
        udid,
        deviceParam,
        wsServer,
        canvasRef,
        bodyRef,
        frameRef,
        wsRef,
        reconnectTimerRef,
        detachControlsRef,
        closingRef,
        destroyedRef,
        streamCfgRef,
        selectOnly,
        getInputTargetsForSource,
        setStatus,
        setLoading,
        reloadRef,
        onVideoDims,
    } = args;
    const { t } = useI18n();
    const tRef = useRef(t);
    useEffect(() => {
        tRef.current = t;
    }, [t]);

    // Keep latest targets getter in a ref so touch controls always see newest sync state.
    const getInputTargetsRef = useRef(getInputTargetsForSource);
    useEffect(() => {
        getInputTargetsRef.current = getInputTargetsForSource;
    }, [getInputTargetsForSource]);

    useEffect(() => {
        destroyedRef.current = false;
        closingRef.current = false;

        const canvas = canvasRef.current;
        const body = frameRef.current || bodyRef.current;
        if (!canvas || !body) return;

        // NOTE: bitmaprenderer is faster but has been observed to render "white tiles" on some GPUs after
        // mid-stream resolution/orientation changes. Use 2D context for stability.
        const bitmapCtx: ImageBitmapRenderingContext | null = null;
        const ctx2d = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D | null;

        function fitCanvasToBody() {
            if (!body || !canvas) {
                return;
            }
            const bw = body.clientWidth;
            const bh = body.clientHeight;
            if (!bw || !bh || !canvas.width || !canvas.height) return;

            const ar = canvas.width / canvas.height;
            let dw = bw;
            let dh = dw / ar;

            if (dh > bh) {
                dh = bh;
                dw = dh * ar;
            }

            canvas.style.width = `${Math.floor(dw)}px`;
            canvas.style.height = `${Math.floor(dh)}px`;
        }

        const ro = new ResizeObserver(fitCanvasToBody);
        ro.observe(body);

        // Fallback for devices/browsers where ResizeObserver is missing or
        // doesn't fire reliably on orientation changes (common on older iOS WebView).
        const scheduleFit = () => {
            // Delay 1 frame to let layout settle after rotation.
            requestAnimationFrame(() => fitCanvasToBody());
        };
        window.addEventListener('resize', scheduleFit, { passive: true } as any);
        window.addEventListener('orientationchange', scheduleFit, { passive: true } as any);
        window.visualViewport?.addEventListener('resize', scheduleFit, { passive: true } as any);
        window.visualViewport?.addEventListener('scroll', scheduleFit, { passive: true } as any);

        function ensureCanvasSize(w: number, h: number) {
            if (!canvas) {
                return;
            }
            // even numbers
            w = w & ~1;
            h = h & ~1;
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
                fitCanvasToBody();
            }
            return { w, h };
        }

        function fnv1a32(u8: Uint8Array): number {
            // 32-bit FNV-1a
            let h = 0x811c9dc5;
            for (let i = 0; i < u8.length; i++) {
                h ^= u8[i];
                // h *= 16777619 (use bit ops)
                h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
            }
            return h >>> 0;
        }

        let firstFrame = false;
        let firstConnect = true;
        let worker: Worker | null = null; // tinyh264 decoder
        let renderWorker: Worker | null = null; // YUV->ImageBitmap renderer
        let decoderReady = false;
        let renderStateId = 1;
        let splitter: AnnexBSplitter | null = null;

        // Watchdog timestamps. If decoding/rendering stalls for too long, we reconnect.
        // This prevents the "white tile until reload" symptom when a worker silently dies
        // or the WS stays open but stops delivering usable frames.
        let lastPacketAt = Date.now();
        let lastBitmapAt = 0;
        // Track last decoded dimensions. Some devices change stream resolution on rotation.
        // A few decoders/workers may get stuck (white screen) on mid-stream dimension changes.
        // We auto-recover by forcing a fresh connection when it happens.
        let lastVideoW = 0;
        let lastVideoH = 0;
        let lastDimRestartAt = 0;
        // Track SPS/PPS changes (can happen on some devices when rotating even if width/height stays the same).
        // tinyh264 sometimes gets stuck on mid-stream parameter set changes -> force reconnect when SPS/PPS changes.
        let lastSpsHash = 0;
        let lastPpsHash = 0;
        let lastParamRestartAt = 0;

        let watchdogTimer: number | null = null;
        let initialLoadTimer: number | null = null;
        // Render throttling: keep at most 1 in-flight render per tile, drop older frames.
        let renderBusy = false;
        let pendingFrame: { width: number; height: number; data: ArrayBuffer } | null = null;
        let frameId = 1;

        const onActivate = () => selectOnly(udid);

        detachControlsRef.current = attachTouchControls(canvas, () => getInputTargetsRef.current(udid), onActivate);

        function makeDecoder() {
            firstFrame = false;
            setLoading(true);
            decoderReady = false;

            // Tear down previous worker if any
            if (worker) {
                try {
                    worker.postMessage({ type: 'release', renderStateId });
                } catch {
                    // ignore
                }
                try {
                    worker.terminate();
                } catch {
                    // ignore
                }
                worker = null;
            }

            const myStateId = renderStateId;

            // Create tinyh264 decoder worker (WASM inside the package)
            worker = new Worker(new URL('../../workers/device_worker.worker.ts', import.meta.url), { type: 'module' });

            // Create per-tile render worker to move YUV->RGBA + bitmap creation off the main thread.
            renderBusy = false;
            pendingFrame = null;
            frameId = 1;

            if (renderWorker) {
                try {
                    renderWorker.postMessage({ type: 'release' });
                } catch {
                    // ignore
                }
                try {
                    renderWorker.terminate();
                } catch {
                    // ignore
                }
                renderWorker = null;
            }

            renderWorker = new Worker(new URL('../../workers/yuvRender.worker.ts', import.meta.url), { type: 'module' });

            renderWorker.onerror = (e) => {
                console.error('[yuv render worker error]', udid, e);
                setStatus(tRef.current('❌ lỗi worker render YUV'));
                setLoading(true);
                // Force fresh GOP on reconnect.
                firstConnect = true;
                // Small async hop to avoid reentrancy issues.
                window.setTimeout(() => {
                    if (!destroyedRef.current) connect();
                }, 0);
            };

            renderWorker.onmessage = (event: MessageEvent) => {
                const msg: any = event.data;
                if (!msg || typeof msg.type !== 'string') return;

                if (msg.type === 'bitmap') {
                    const width: number = msg.width;
                    const height: number = msg.height;
                    const bitmap: ImageBitmap = msg.bitmap;

                    // If canvas has no size yet, set it once (for aspect ratio / CSS fit)
                    if (width && height) {
                        ensureCanvasSize(width, height);
                        fitCanvasToBody();
                        onVideoDims?.(width, height);
                    }

                    try {
                        if (bitmapCtx) {
                            bitmapCtx.transferFromImageBitmap(bitmap);
                        } else if (ctx2d) {
                            ctx2d.drawImage(bitmap, 0, 0);
                        }
                        try {
                            bitmap.close?.();
                        } catch {
                            // ignore
                        }
                    } catch (e) {
                        console.error('[present bitmap]', udid, e);
                    }

                    if (!firstFrame) {
                        if (!canvas) {
                            return;
                        }
                        firstFrame = true;
                        if (initialLoadTimer != null) {
                            clearTimeout(initialLoadTimer);
                            initialLoadTimer = null;
                        }
                        setLoading(false);
                        setStatus('');
                    }

                    // Mark render as healthy.
                    lastBitmapAt = Date.now();

                    renderBusy = false;
                    if (pendingFrame && renderWorker) {
                        const f = pendingFrame;
                        pendingFrame = null;
                        renderBusy = true;
                        const id = ++frameId;
                        try {
                            renderWorker.postMessage(
                                { type: 'render', width: f.width, height: f.height, data: f.data, frameId: id },
                                [f.data],
                            );
                        } catch (e) {
                            renderBusy = false;
                            console.error('[renderWorker postMessage]', udid, e);
                        }
                    }
                    return;
                }

                if (msg.type === 'error') {
                    renderBusy = false;
                    return;
                }
            };

            worker.onmessage = (event: MessageEvent) => {
                const msg: any = event.data;
                if (!msg || typeof msg.type !== 'string') return;

                // Ignore late frames from old states
                if (typeof msg.renderStateId === 'number' && msg.renderStateId !== myStateId) return;

                if (msg.type === 'decoderReady') {
                    decoderReady = true;
                    return;
                }

                if (msg.type === 'pictureReady') {
                    const width: number = msg.width;
                    const height: number = msg.height;
                    const data: ArrayBuffer = msg.data;

                    if (!data || !width || !height || !renderWorker) return;

                    // Some devices switch resolution on rotation (portrait<->landscape).
                    // A subset of devices/decoders can get stuck (white screen) after that.
                    // When we detect a dimension change after the first frame, force a fresh
                    // WS connection (restart=1) to recover.
                    if (firstFrame && (width !== lastVideoW || height !== lastVideoH)) {
                        const now = Date.now();
                        // Throttle: avoid loops if device toggles frequently.
                        if (now - lastDimRestartAt > 1500) {
                            lastDimRestartAt = now;
                            lastVideoW = width;
                            lastVideoH = height;
                            setStatus(tRef.current('Thay đổi xoay/kích thước - khởi động lại…'));
                            setLoading(true);
                            firstConnect = true;
                            // reconnect (recreate workers + fresh GOP)
                            connect();
                            return;
                        }
                    }

                    // Update dims baseline
                    lastVideoW = width;
                    lastVideoH = height;

                    // Offload YUV->bitmap to render worker; keep only newest if worker is busy.
                    if (renderBusy) {
                        pendingFrame = { width, height, data };
                        return;
                    }

                    renderBusy = true;
                    const id = ++frameId;
                    try {
                        renderWorker.postMessage({ type: 'render', width, height, data, frameId: id }, [data]);
                    } catch (e) {
                        renderBusy = false;
                        console.error('[renderWorker postMessage]', udid, e);
                    }
                    return;
                }

                // Unknown message type
            };

            worker.onerror = (e) => {
                console.error('[tinyh264 worker error]', udid, e);
                setStatus(tRef.current('❌ lỗi worker tinyh264'));
                setLoading(true);
                // Same symptom as "white tile": the decoder worker crashed.
                // Reconnect with restart=1 so we get SPS/PPS + IDR again.
                firstConnect = true;
                window.setTimeout(() => {
                    if (!destroyedRef.current) connect();
                }, 0);
            };

            splitter = new AnnexBSplitter((naluWithStartCode) => {
                if (!worker || !decoderReady) return;

                // Copy before transferring (splitter may hand us a view)
                const payload = new Uint8Array(naluWithStartCode);
                if (payload.length < 5) return;

                // Detect SPS/PPS changes mid-stream (common on some devices when rotating).
                // When tinyh264 gets stuck after such change, reconnect with restart=1.
                let startLen = 0;
                if (payload[2] === 0x01) startLen = 3;
                else if (payload[2] === 0x00 && payload[3] === 0x01) startLen = 4;
                if (startLen) {
                    const nalType = payload[startLen] & 0x1f;
                    if (nalType === 7 || nalType === 8) {
                        const now = Date.now();
                        const h = fnv1a32(payload.subarray(startLen));
                        if (nalType === 7) {
                            if (firstFrame && lastSpsHash && h !== lastSpsHash && now - lastParamRestartAt > 1500) {
                                lastParamRestartAt = now;
                                lastSpsHash = h;
                                setStatus(tRef.current('SPS đổi - khởi động lại…'));
                                setLoading(true);
                                firstConnect = true;
                                connect();
                                return;
                            }
                            lastSpsHash = h;
                        } else {
                            if (firstFrame && lastPpsHash && h !== lastPpsHash && now - lastParamRestartAt > 1500) {
                                lastParamRestartAt = now;
                                lastPpsHash = h;
                                setStatus(tRef.current('PPS đổi - khởi động lại…'));
                                setLoading(true);
                                firstConnect = true;
                                connect();
                                return;
                            }
                            lastPpsHash = h;
                        }
                    }
                }

                try {
                    worker.postMessage(
                        {
                            type: "decode",
                            data: payload.buffer,
                            offset: 0,
                            length: payload.byteLength,
                            renderStateId: myStateId,
                        },
                        [payload.buffer],
                    );
                } catch (e) {
                    console.error("[decode]", udid, e);
                }
            });
        }

        function cleanupWs() {
            closingRef.current = true;
            const prev = wsRef.current;
            if (prev) {
                // prevent onclose from scheduling a reconnect when we intentionally close
                prev.onopen = null;
                prev.onmessage = null;
                prev.onerror = null;
                prev.onclose = null;
                try {
                    prev.close();
                } catch {
                    // ignore
                }
            }
            wsRef.current = null;

            // Stop decoder worker + reset stream state
            if (worker) {
                try {
                    worker.postMessage({ type: 'release', renderStateId });
                } catch {
                    // ignore
                }
                try {
                    worker.terminate();
                } catch {
                    // ignore
                }
                worker = null;
            }

            if (renderWorker) {
                try {
                    renderWorker.postMessage({ type: 'release' });
                } catch {
                    // ignore
                }
                try {
                    renderWorker.terminate();
                } catch {
                    // ignore
                }
                renderWorker = null;
            }

            decoderReady = false;
            renderStateId++;
            splitter = null;

            if (reconnectTimerRef.current != null) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }

            if (initialLoadTimer != null) {
                clearTimeout(initialLoadTimer);
                initialLoadTimer = null;
            }
        }

        function connect() {
            cleanupWs();
            makeDecoder();

            let url: string;
            try {
                url = makeWsUrl({ wsServer, deviceParam, udid, restart: firstConnect });
            } catch (err) {
                setStatus(tRef.current('❌ thiếu tham số thiết bị'));
                setLoading(false);
                return;
            }
            firstConnect = false;

            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            closingRef.current = false;
            wsRef.current = ws;

            setStatus(tRef.current('Đang kết nối…'));

            // If we don't get the first decoded frame within 10 seconds,
            // auto-reload this tile (same device) to recover from the stuck 'loading' state.
            if (initialLoadTimer != null) {
                clearTimeout(initialLoadTimer);
                initialLoadTimer = null;
            }
            initialLoadTimer = window.setTimeout(() => {
                if (destroyedRef.current || closingRef.current) return;
                if (firstFrame) return;
                setStatus(tRef.current('⏱️ tải >10s - đang reload…'));
                setLoading(true);
                firstConnect = true; // force fresh GOP (SPS/PPS + IDR)
                connect();
            }, 10_000);

            ws.onopen = () => {
                setStatus(tRef.current('WS mở → gửi config BINARY…'));
                try {
                    ws.send(buildConfigBinary(streamCfgRef.current));
                    setStatus(tRef.current("Đang chờ phản hồi"));
                } catch (e) {
                    console.error('send binary config failed', e);
                    setStatus(tRef.current('❌ Thất bại'));
                }
            };

            ws.onmessage = async (ev) => {
                let ab: ArrayBuffer | null = null;
                if (ev.data instanceof ArrayBuffer) ab = ev.data;
                else if (ev.data instanceof Blob) ab = await ev.data.arrayBuffer();
                if (!ab) return;
                lastPacketAt = Date.now();
                splitter?.push(new Uint8Array(ab));
            };

            ws.onerror = () => setStatus(tRef.current('❌ lỗi WS'));

            ws.onclose = (e) => {
                if (closingRef.current || destroyedRef.current) return;
                if (initialLoadTimer != null) {
                    clearTimeout(initialLoadTimer);
                    initialLoadTimer = null;
                }
                setStatus(
                    tRef.current('WS đóng ({code}{reason}) - thử lại…', {
                        code: e.code,
                        reason: e.reason ? `: ${e.reason}` : '',
                    }),
                );
                setLoading(true);

                // Important for stability:
                // When reconnecting after a disconnect, force "restart=1" so the server starts a fresh GOP
                // (SPS/PPS + IDR). Otherwise the decoder may receive only P-frames and crash the tinyh264 worker.
                firstConnect = true;

                reconnectTimerRef.current = window.setTimeout(() => {
                    if (destroyedRef.current) return;
                    connect();
                }, 1200);
            };
        }

        // Allow user to manually reload this tile (recreate workers + reconnect WS).
        reloadRef.current = () => {
            if (destroyedRef.current) return;
            setLoading(true);
            setStatus(tRef.current('Đang reload…'));
            // Force server-side restart on next connect (same behavior as first connect).
            firstConnect = true;
            connect();
        };

        connect();

        // Periodically detect "stuck" tiles: WS open but no packets or no rendered bitmaps.
        // When it happens the canvas often goes white (canvas resize clears pixels) and never recovers
        // until manual reload. This auto-recovers without user action.
        watchdogTimer = window.setInterval(() => {
            if (destroyedRef.current || closingRef.current) return;
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            if (!firstFrame) return; // don't trigger while still connecting / before first frame

            const now = Date.now();
            const packetAge = now - lastPacketAt;
            const bitmapAge = lastBitmapAt ? now - lastBitmapAt : 1e9;

            // Only reconnect when we have evidence of a "stuck" decoder:
            // - packets still arrive, but we stop producing bitmaps
            // Avoid reconnecting just because the screen is static and no frames arrive.
            const packetsStillArriving = packetAge < 2500;
            const outputStalled = bitmapAge > 8000;
            if (packetsStillArriving && outputStalled) {
                setStatus(tRef.current('⚠️ decode đứng - kết nối lại…'));
                setLoading(true);
                firstConnect = true;
                connect();
                return;
            }

            // Safety net: if absolutely nothing arrives for a long time, try reconnecting occasionally.
            // Keep this very conservative to avoid annoying auto-reloads.
            if (packetAge > 300000 && bitmapAge > 300000) {
                setStatus(tRef.current('⚠️ idle lâu - kết nối lại…'));
                setLoading(true);
                firstConnect = true;
                connect();
            }
        }, 3000);

        const closeWs = () => {
            cleanupWs();
            try {
                detachControlsRef.current?.();
            } catch {
                // ignore
            }
        };

        window.addEventListener('beforeunload', closeWs);
        window.addEventListener('pagehide', closeWs);

        return () => {
            destroyedRef.current = true;
            closingRef.current = true;
            reloadRef.current = null;
            ro.disconnect();
            window.removeEventListener('resize', scheduleFit as any);
            window.removeEventListener('orientationchange', scheduleFit as any);
            window.visualViewport?.removeEventListener('resize', scheduleFit as any);
            window.visualViewport?.removeEventListener('scroll', scheduleFit as any);
            window.removeEventListener('beforeunload', closeWs);
            window.removeEventListener('pagehide', closeWs);
            if (watchdogTimer != null) {
                clearInterval(watchdogTimer);
                watchdogTimer = null;
            }
            closeWs();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [udid, deviceParam, wsServer, selectOnly]);
}
