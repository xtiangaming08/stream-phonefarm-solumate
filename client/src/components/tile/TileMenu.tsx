import React from 'react';
import {
    ArrowDown,
    ArrowUp,
    Camera,
    Eye,
    Hash,
    RefreshCw,
    Volume1,
    Volume2,
    X,
} from 'lucide-react';

type Props = {
    udid: string;
    orderIndex?: number;

    // Optional parent callbacks (these were optional in the original Tile props)
    onView?: (udid: string) => void;
    onMove?: (udid: string, dir: -1 | 1) => void;
    onSetOrderIndex?: (udid: string, index: number) => void;

    // Actions (all logic lives in the Tile container)
    onReload: () => void;
    onScreenshot: () => void;
    onVolUp: () => void;
    onVolDown: () => void;
    onClose: () => void;
};

/**
 * Context menu inside a tile.
 *
 * NOTE: Keep button order & icons identical to the original to avoid
 * accidental UX changes.
 */
export function TileMenu({
    udid,
    orderIndex,
    onView,
    onMove,
    onSetOrderIndex,
    onReload,
    onScreenshot,
    onVolUp,
    onVolDown,
        onClose,
}: Props) {
    return (
        <div className="tileMenu" onClick={(e) => e.stopPropagation()}>
            <button className="tileMenuBtn" title="Reload stream" onClick={() => onReload()}>
                <RefreshCw size={18} strokeWidth={1.8} />
            </button>

            {onView ? (
                <button
                    className="tileMenuBtn"
                    title="View"
                    onClick={() => {
                        onView(udid);
                        onClose();
                    }}
                >
                    <Eye size={18} strokeWidth={1.8} />
                </button>
            ) : null}

            <div className="tileMenuSep" />

            {onMove ? (
                <>
                    <button className="tileMenuBtn" title="Move up" onClick={() => onMove(udid, -1)}>
                        <ArrowUp size={18} strokeWidth={1.8} />
                    </button>
                    <button className="tileMenuBtn" title="Move down" onClick={() => onMove(udid, 1)}>
                        <ArrowDown size={18} strokeWidth={1.8} />
                    </button>
                </>
            ) : null}

            {onSetOrderIndex ? (
                <button
                    className="tileMenuBtn"
                    title="Set order index"
                    onClick={() => {
                        const cur = typeof orderIndex === 'number' ? String(orderIndex) : '';
                        const s = window.prompt('Order index (1..N):', cur);
                        if (!s) return;
                        const n = Number(s);
                        if (!Number.isFinite(n) || n <= 0) return;
                        onSetOrderIndex(udid, Math.floor(n));
                    }}
                >
                    <Hash size={18} strokeWidth={1.8} />
                </button>
            ) : null}

            {(onMove || onSetOrderIndex) ? <div className="tileMenuSep" /> : null}

            <button className="tileMenuBtn" title="Vol +" onClick={() => onVolUp()}>
                <Volume2 size={18} strokeWidth={1.8} />
            </button>
            <button className="tileMenuBtn" title="Vol -" onClick={() => onVolDown()}>
                <Volume1 size={18} strokeWidth={1.8} />
            </button>
            <button className="tileMenuBtn" title="Screenshot" onClick={() => onScreenshot()}>
                <Camera size={18} strokeWidth={1.8} />
            </button>

            <div className="tileMenuSep" />

            <button className="tileMenuBtn" title="Close" onClick={() => onClose()}>
                <X size={18} strokeWidth={2} />
            </button>
        </div>
    );
}
