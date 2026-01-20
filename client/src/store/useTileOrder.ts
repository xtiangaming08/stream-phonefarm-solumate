import { useEffect, useMemo, useState } from 'react';

// Manage ordering of device tiles. Persists to localStorage.
export function useTileOrder(defaultDevices: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('tileOrder');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
    } catch {
      // ignore
    }
    return [];
  });

  // Keep order in sync with discovered devices
  const mergedOrder = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of order) {
      if (defaultDevices.includes(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const id of defaultDevices) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    return out;
  }, [order, defaultDevices]);

  useEffect(() => {
    try {
      localStorage.setItem('tileOrder', JSON.stringify(mergedOrder));
    } catch {
      // ignore
    }
  }, [mergedOrder]);

  const moveTile = (udid: string, toIndex: number) => {
    const idx = mergedOrder.indexOf(udid);
    if (idx < 0) return;
    const clampedIndex = Math.max(0, Math.min(mergedOrder.length - 1, toIndex));
    if (idx === clampedIndex) return;
    const next = [...mergedOrder];
    next.splice(idx, 1);
    next.splice(clampedIndex, 0, udid);
    setOrder(next);
  };

  return { mergedOrder, moveTile };
}
