import type { StreamConfig } from '@/lib/config';

/**
 * Minimal props for a single device tile (stream + basic actions).
 */
export type TileProps = {
    udid: string;
    deviceParam: string | null;
    wsServer: string;
    streamConfig: StreamConfig;
    order?: number;
    isViewing?: boolean;
    selected?: boolean;
    onRegisterReload?: (udid: string, reload: () => void) => void;
    onUnregisterReload?: (udid: string) => void;
    onViewDevice?: (udid: string) => void;
    onMove?: (udid: string, toIndex: number) => void;
    onDragStart?: (udid: string) => void;
    onDragEnd?: () => void;
};
