/** Profiles (groups) saved in localStorage. No backend calls here. */

export type TileDims = { width: number; height: number };

export type LayoutCfg = {
  mode: 'auto' | 'fixed';
  cols: number;
  gap: number;
  favoritesOnly: boolean;
  favoritesOnTop: boolean;
  hideOffline: boolean;
};

export type Profile = {
  id: string;
  name: string;
  tileDims: TileDims;
  layout: LayoutCfg;
  syncEnabled: boolean;
  syncUdids: string[];
  controlUdids: string[];
  createdAt: number;
  updatedAt: number;
};

const KEY = 'config_profiles_v1';

function uniq(arr: string[]): string[] {
  const s = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!s.has(x)) {
      s.add(x);
      out.push(x);
    }
  }
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return uniq(v.filter((x) => typeof x === 'string').map((x) => String(x)));
}

export function defaultLayoutCfg(): LayoutCfg {
  return {
    mode: 'auto',
    cols: 0,
    gap: 8,
    favoritesOnly: false,
    favoritesOnTop: true,
    hideOffline: false,
  };
}

export function normalizeLayoutCfg(partial: Partial<LayoutCfg> | null | undefined, fallback: LayoutCfg): LayoutCfg {
  const p = partial ?? {};
  const mode = p.mode === 'fixed' ? 'fixed' : 'auto';
  const cols = Number.isFinite(Number(p.cols)) ? Math.max(0, Math.floor(Number(p.cols))) : fallback.cols;
  const gap = Number.isFinite(Number(p.gap)) ? Math.max(0, Math.min(50, Math.floor(Number(p.gap)))) : fallback.gap;
  return {
    mode,
    cols,
    gap,
    favoritesOnly: Boolean(p.favoritesOnly ?? fallback.favoritesOnly),
    favoritesOnTop: Boolean(p.favoritesOnTop ?? fallback.favoritesOnTop),
    hideOffline: Boolean(p.hideOffline ?? fallback.hideOffline),
  };
}

export function normalizeTileDims(partial: Partial<TileDims> | null | undefined, fallback: TileDims): TileDims {
  const p = partial ?? {};
  const width = Number.isFinite(Number(p.width)) ? Math.max(100, Math.min(4000, Math.floor(Number(p.width)))) : fallback.width;
  const height = Number.isFinite(Number(p.height)) ? Math.max(100, Math.min(4000, Math.floor(Number(p.height)))) : fallback.height;
  return { width, height };
}

export function makeProfileId(): string {
  // Simple, stable id for local use
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function loadProfiles(fallbackLayout: LayoutCfg, fallbackDims: TileDims): Profile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const out: Profile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof (item as any).id === 'string' ? String((item as any).id) : makeProfileId();
      const name = typeof (item as any).name === 'string' ? String((item as any).name) : 'Profile';
      const tileDims = normalizeTileDims((item as any).tileDims, fallbackDims);
      const layout = normalizeLayoutCfg((item as any).layout, fallbackLayout);
      const syncEnabled = Boolean((item as any).syncEnabled);
      const syncUdids = asStringArray((item as any).syncUdids);
      const controlUdids = asStringArray((item as any).controlUdids);
      const createdAt = Number.isFinite(Number((item as any).createdAt)) ? Number((item as any).createdAt) : Date.now();
      const updatedAt = Number.isFinite(Number((item as any).updatedAt)) ? Number((item as any).updatedAt) : createdAt;
      out.push({ id, name, tileDims, layout, syncEnabled, syncUdids, controlUdids, createdAt, updatedAt });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: Profile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

export function upsertProfile(profiles: Profile[], next: Profile): Profile[] {
  const idx = profiles.findIndex((p) => p.id === next.id);
  const merged = { ...next, syncUdids: uniq(next.syncUdids), controlUdids: uniq(next.controlUdids) };
  if (idx < 0) return [...profiles, merged];
  const out = [...profiles];
  out[idx] = merged;
  return out;
}

export function removeProfile(profiles: Profile[], id: string): Profile[] {
  return profiles.filter((p) => p.id !== id);
}
