import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActive } from '@/context/ActiveContext';
import type { StreamConfig } from '@/lib/config';
import { encodeKeycodeMessage, KeyEventAction } from '@/lib/control';
import { AndroidKeycode } from '@/lib/keyEvent';
import { useI18n } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';

import type { TileProps } from './types';
import { TileHeader } from './TileHeader';
import { TileNav } from './TileNav';
import { useTileStream } from './useTileStream';
import { AlertTriangle, Info, MousePointer2, XCircle } from 'lucide-react';

/**
 * Device tile.
 *
 * This file keeps all behavior/logic identical to the original monolithic
 * src/components/Tile.tsx, but splits UI pieces and the streaming pipeline
 * into smaller modules with comments so it's easier to maintain.
 */
function TileComponent({
    udid,
    deviceParam,
    wsServer,
    streamConfig,
    order,
    isViewing = false,
    selected = false,
    onRegisterReload,
    onUnregisterReload,
    onViewDevice,
    onMove,
    onDragStart,
    onDragEnd,
}: TileProps) {
    const { t } = useI18n();
    const {
        activeUdid,
        registerDevice,
        unregisterDevice,
        selectOnly,
        getInputTargetsForSource,
        syncAll,
        syncMain,
        syncTargets,
        setSyncMain,
        toggleSyncTarget,
    } = useActive();
    const { androidDeviceMap } = useServer();

    const isActive = activeUdid === udid;
    const connectionLabel = useMemo(() => {
        const meta = androidDeviceMap[udid];
        const ifaceNames = meta?.interfaces?.map((i) => i.name.toLowerCase()) || [];
        const hasWifiIface = ifaceNames.some((n) => n.includes('wlan') || n.includes('wifi') || n.includes('wl'));
        const hasUsbIface = ifaceNames.some((n) => n.includes('usb') || n.includes('rndis'));
        if (hasWifiIface) return 'WIFI';
        if (hasUsbIface) return 'USB';
        if (udid.includes(':')) return 'WIFI';
        return 'USB';
    }, [androidDeviceMap, udid]);
    const isSyncMain = syncAll && syncMain === udid;
    const isSyncFollower = syncAll && syncTargets.includes(udid);
    const syncRole = isSyncMain ? 'main' : isSyncFollower ? 'follower' : null;
    const buildHashUrl = useCallback(
        (action: 'shell' | 'list-files') => {
            const u = new URL(window.location.href);
            if (action === 'shell') {
                u.hash = `!action=shell&udid=${encodeURIComponent(udid)}`;
            } else {
                u.hash = `!action=list-files&udid=${encodeURIComponent(udid)}&path=${encodeURIComponent('/data/local/tmp/')}`;
            }
            return u.toString();
        },
        [udid],
    );
    const buildSingleViewUrl = useCallback(() => {
        const u = new URL(window.location.href);
        u.searchParams.set('device', udid);
        u.hash = '';
        return u.toString();
    }, [udid]);

    // ===== DOM + runtime refs =====
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<number | null>(null);
    const detachControlsRef = useRef<(() => void) | null>(null);
    const closingRef = useRef(false);
    const destroyedRef = useRef(false);

    // ===== UI state =====
    const [status, setStatus] = useState(t('Khởi tạo…'));
    const [loading, setLoading] = useState(true);
    const [videoAspect, setVideoAspect] = useState<number>(9 / 16);

    // Expose a per-tile reload handler to the UI (header/menu buttons)
    // and to parent App ("reload all tiles").
    const reloadRef = useRef<(() => void) | null>(null);

    // Keep latest streamConfig in a ref so ws.onopen/reload always send newest config
    // without forcing the heavy streaming effect to re-run on every slider tick.
    const streamCfgRef = useRef<StreamConfig>(streamConfig);
    useEffect(() => {
        streamCfgRef.current = streamConfig;
    }, [streamConfig]);

    // Register a stable reload wrapper with the parent (App) so it can "reload all tiles".
    useEffect(() => {
        if (!onRegisterReload) return;
        const wrapper = () => {
            try {
                reloadRef.current?.();
            } catch {
                // ignore
            }
        };
        onRegisterReload(udid, wrapper);
        return () => onUnregisterReload?.(udid);
    }, [udid, onRegisterReload, onUnregisterReload]);

    // Register this tile into ActiveContext so other tiles can broadcast inputs to it.
    const getWs = useMemo(() => () => wsRef.current, []);
    const getCanvas = useMemo(() => () => canvasRef.current, []);
    useEffect(() => {
        registerDevice({ udid, getWs, getCanvas });
        return () => unregisterDevice(udid);
    }, [udid, getWs, getCanvas, registerDevice, unregisterDevice]);

    // ===== Streaming pipeline (WS + workers + canvas fit + touch controls) =====
    useTileStream({
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
        onVideoDims: (w, h) => {
            if (!w || !h) return;
            setVideoAspect(w / h);
        },
    });

    // ===== Input sending helpers (unchanged) =====
    const sendKeyTapTargets = useCallback(
        (keycode: number) => {
            const targets = getInputTargetsForSource(udid);
            const down = encodeKeycodeMessage(KeyEventAction.DOWN, keycode);
            const up = encodeKeycodeMessage(KeyEventAction.UP, keycode);
            for (const t of targets) {
                try {
                    t.ws.send(down);
                    t.ws.send(up);
                } catch {
                    // ignore
                }
            }
        },
        [getInputTargetsForSource, udid],
    );

    const screenshotThisCanvas = useCallback(() => {
        const c = canvasRef.current;
        if (!c) return;
        try {
            const a = document.createElement('a');
            a.download = `${udid}_${Date.now()}.png`;
            a.href = c.toDataURL('image/png');
            a.click();
        } catch (e) {
            console.warn('screenshot failed', e);
        }
    }, [udid]);

    // ===== Header click behavior (single active on click) =====
    const onHeaderClick = useCallback(
        (e: React.MouseEvent) => {
            selectOnly(udid);
            canvasRef.current?.focus?.();
        },
        [selectOnly, udid],
    );

    // When user triggers any tile-specific action, keep focus on this tile.
    const focusThisTile = useCallback(() => {
        selectOnly(udid);
    }, [selectOnly, udid]);

    const tileClass = `tile${isActive ? ' active' : ''}${selected ? ' selected' : ''}${
        isSyncMain ? ' sync-main' : ''
    }${isSyncFollower ? ' sync-follower' : ''}${isViewing ? ' viewing' : ''}`;

    const viewingLabel = t('Đang điều khiển');
    const viewingHint = t('Thiết bị đang mở trong viewer — tránh điều khiển trùng lặp');

    const statusTrimmed = (status || '').trim();
    const statusTone = statusTrimmed.startsWith('❌')
        ? 'error'
        : statusTrimmed.startsWith('⚠️')
            ? 'warn'
            : 'info';
    const statusIcon =
        statusTone === 'error' ? (
            <XCircle size={38} strokeWidth={2} />
        ) : statusTone === 'warn' ? (
            <AlertTriangle size={38} strokeWidth={2} />
        ) : (
            <Info size={38} strokeWidth={2} />
        );

    const videoFrame = (
        <div className="tileVideoFrame" ref={frameRef} aria-hidden={isViewing}>
            <canvas ref={canvasRef} style={{ touchAction: 'none' }} tabIndex={0} />
        </div>
    );

    return (
        <div
            className={tileClass}
            data-udid={udid}
            style={{ ['--tile-aspect' as any]: videoAspect || 0.5625 }}
        >
            <TileHeader
                udid={udid}
                order={order}
                status={status}
                syncRole={syncRole}
                connectionLabel={connectionLabel}
                onHeaderClick={onHeaderClick}
                onReloadClick={(e) => {
                    e.stopPropagation();
                    focusThisTile();
                    reloadRef.current?.();
                }}
                onViewClick={() => {
                    if (onViewDevice) onViewDevice(udid);
                }}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onMove={onMove}
            />

            <div className="tileBody" ref={bodyRef}>
                {!isViewing && loading ? (
                    <div className="loading">
                        <div className="spinner"></div>
                    </div>
                ) : null}

                {videoFrame}

                {isViewing ? (
                    <div className="tileViewingOverlay">
                        <div className="tileViewingIcon" aria-hidden="true">
                            <MousePointer2 size={44} strokeWidth={1.8} />
                        </div>
                        <div className="tileViewingTitle">{viewingLabel}</div>
                        <div className="tileViewingHint">{viewingHint}</div>
                    </div>
                ) : statusTrimmed ? (
                    <div className={`tileStatusOverlay ${statusTone}`}>
                        <div className="tileStatusIcon" aria-hidden="true">
                            {statusIcon}
                        </div>
                        <div className="tileStatusText">{statusTrimmed}</div>
                    </div>
                ) : null}
            </div>

            {isViewing ? (
                <div className="tileViewingFooter">{t('Đang hiển thị trên viewer')}</div>
            ) : (
                <TileNav
                    onBack={() => sendKeyTapTargets(AndroidKeycode.KEYCODE_BACK)}
                    onHome={() => sendKeyTapTargets(AndroidKeycode.KEYCODE_HOME)}
                    onRecent={() => sendKeyTapTargets(AndroidKeycode.KEYCODE_APP_SWITCH)}
                />
            )}
        </div>
    );
}
export const Tile = memo(TileComponent);
