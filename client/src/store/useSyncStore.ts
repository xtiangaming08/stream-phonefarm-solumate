import { useMemo, useCallback } from 'react';
import { useActive } from '@/context/ActiveContext';

export function useSyncStore(orderOverride?: string[]) {
  const {
    syncAll,
    setSyncAll,
    syncMain,
    setSyncMain,
    syncTargets,
    toggleSyncTarget,
    registeredUdids,
    stopSync,
  } = useActive();

  const baseUdids = orderOverride ?? registeredUdids;

  const orderedUdids = (() => {
    const saved: string[] = (() => {
      try {
        const raw = localStorage.getItem('tileOrder');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
      } catch {
        // ignore
      }
      return [];
    })();

    const seen = new Set<string>();
    const out: string[] = [];

    for (const id of saved) {
      if (baseUdids.includes(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const id of baseUdids) {
      if (!seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    return out;
  })();

  const followerCandidates = useMemo(
    () => orderedUdids.filter((id) => id !== syncMain),
    [orderedUdids, syncMain],
  );

  const allFollowersChecked = useMemo(() => {
    if (!followerCandidates.length) return false;
    return followerCandidates.every((id) => syncTargets.includes(id));
  }, [followerCandidates, syncTargets]);

  const toggleAllFollowers = useCallback(
    (checked: boolean) => {
      followerCandidates.forEach((id) => {
        const exists = syncTargets.includes(id);
        if (checked && !exists) toggleSyncTarget(id);
        if (!checked && exists) toggleSyncTarget(id);
      });
    },
    [followerCandidates, syncTargets, toggleSyncTarget],
  );

  const selectMain = useCallback(
    (id: string | null) => {
      // remove main from follower list when switching
      if (id && syncTargets.includes(id)) toggleSyncTarget(id);
      setSyncMain(id);
    },
    [setSyncMain, syncTargets, toggleSyncTarget],
  );

  return {
    syncAll,
    setSyncAll,
    syncMain,
    setSyncMain: selectMain,
    syncTargets,
    toggleSyncTarget,
    registeredUdids: orderedUdids,
    orderedUdids,
    followerCandidates,
    allFollowersChecked,
    toggleAllFollowers,
    stopSync,
  };
}
