import React from 'react';
import { useI18n } from '@/context/I18nContext';
import { Eye, GripVertical, RefreshCw } from 'lucide-react';

type Props = {
    udid: string;
    order?: number;
    status: string;
    syncRole: 'main' | 'follower' | null;
    onHeaderClick: (e: React.MouseEvent) => void;
    onReloadClick: (e: React.MouseEvent) => void;
    connectionLabel?: string;
    onViewClick?: () => void;
    onMove?: (udid: string, toIndex: number) => void;
    onDragStart?: (udid: string) => void;
    onDragEnd?: () => void;
};

/**
 * Tile header (UDID, status, reload).
 */
export function TileHeader({
    udid,
    order,
    status,
    syncRole,
    onHeaderClick,
    onReloadClick,
    connectionLabel,
    onViewClick,
    onMove,
    onDragStart,
    onDragEnd,
}: Props) {
    const { t } = useI18n();
    const connClass =
        connectionLabel?.toLowerCase() === 'usb'
            ? ' usb'
            : connectionLabel?.toLowerCase() === 'wifi'
                ? ' wifi'
                : '';
    return (
            <div className="tileHeader" onClick={onHeaderClick} title={udid}>
                <div className="left">
                    <div className="udidRow">
                      {typeof order === 'number' ? (
                          <div className="tileNumber">{String(order).padStart(2, '0')}</div>
                      ) : null}
                      {connectionLabel ? <div className={`tileConnChip${connClass}`}>{connectionLabel}</div> : null}
                      {syncRole ? (
                          <div className={`tileSyncChip ${syncRole}`}>{syncRole === 'main' ? t('Chính') : t('Phụ')}</div>
                      ) : null}
                    </div>
                </div>

            <div className="tileActions">
                <button
                    className="tileDragHandle"
                    title={t('Kéo để di chuyển tile')}
                    draggable
                    onDragStart={(e) => {
                        e.stopPropagation();
                        onDragStart?.(udid);
                    }}
                    onDragEnd={(e) => {
                        e.stopPropagation();
                        onDragEnd?.();
                        e.currentTarget.blur();
                    }}
                >
                    <GripVertical size={16} strokeWidth={1.8} />
                </button>
                <button
                    className="tileViewBtn"
                    title={t('Xem device riêng')}
                    onClick={(e) => {
                        e.stopPropagation();
                        onViewClick?.();
                    }}
                >
                    <Eye size={16} strokeWidth={1.8} />
                </button>
                <button className="tileReloadBtn" title={t('Tải lại stream')} onClick={onReloadClick}>
                    <RefreshCw size={16} strokeWidth={1.8} />
                </button>
            </div>
        </div>
    );
}
