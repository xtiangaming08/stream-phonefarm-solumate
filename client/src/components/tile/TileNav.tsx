import React from 'react';
import { useI18n } from '@/context/I18nContext';
import { ArrowLeft, Home, Menu } from 'lucide-react';

type Props = {
    onBack: () => void;
    onHome: () => void;
    onRecent: () => void;
};

/**
 * Always-visible navigation buttons (Back / Home / Recent).
 *
 * Kept separate so the main Tile container focuses on streaming + state.
 */
export function TileNav({ onBack, onHome, onRecent }: Props) {
    const { t } = useI18n();
    return (
        <div className="tileNav" onClick={(e) => e.stopPropagation()}>
            <button className="tileNavBtn" title={t('Quay lại')} onClick={() => onBack()}>
                <ArrowLeft size={16} strokeWidth={1.8} />
            </button>
            <button className="tileNavBtn" title={t('Về Home')} onClick={() => onHome()}>
                <Home size={16} strokeWidth={1.8} />
            </button>
            <button className="tileNavBtn" title={t('Đa nhiệm')} onClick={() => onRecent()}>
                <Menu size={16} strokeWidth={1.8} />
            </button>
        </div>
    );
}
