import React from 'react';
import { useI18n } from '@/context/I18nContext';
import { useSyncStore } from '@/store/useSyncStore';

type Props = {
  orderedUdids?: string[];
};

export function SyncPanel({ orderedUdids }: Props) {
  const { t } = useI18n();
  const {
    syncAll,
    setSyncAll,
    syncMain,
    setSyncMain,
    syncTargets,
    toggleSyncTarget,
    followerCandidates,
    allFollowersChecked,
    toggleAllFollowers,
    stopSync,
    orderedUdids: sortedUdids,
  } = useSyncStore(orderedUdids);

  const idToNumber = React.useMemo(() => {
    const map = new Map<string, number>();
    sortedUdids.forEach((id, idx) => map.set(id, idx + 1));
    return map;
  }, [sortedUdids]);

  return (
    <div className='rcpSection'>
      <div className='rcpTitle'>{t('Sync thiết bị')}</div>
      <div className='rcpToggleRow'>
        <span>{syncAll ? t('Đang sync') : t('Sync tắt')}</span>
        <button className={`rcpTab ${syncAll ? 'active' : ''}`} onClick={() => setSyncAll(!syncAll)}>
          {syncAll ? t('Tắt') : t('Bật')}
        </button>
      </div>

      {syncAll ? (
        <>
          <div className='rcpSyncHint'>
            {syncMain
              ? t('Đang sync: {main} → {count} device phụ', {
                  main: syncMain,
                  count: syncTargets.length,
                })
              : t('Không đặt device chính — mọi device sẽ điều khiển nhóm đã chọn')}
          </div>

          <div className='rcpDeviceHeader'>
            <span>{t('Device chính')}</span>
          </div>
          <div className='rcpGridWrap'>
            <div className='rcpGrid rcpGridCompact'>
            {sortedUdids.map((id) => (
              <label key={id} className={`rcpGridItem${syncMain === id ? ' on' : ''}`}>
                <input
                  type='radio'
                  name='sync-main'
                  checked={syncMain === id}
                  onChange={() => setSyncMain(id)}
                />
                <span>{String(idToNumber.get(id) || 0).padStart(2, '0')}</span>
              </label>
            ))}
              <label className={`rcpGridItem${!syncMain ? ' on' : ''}`}>
                <input type='radio' name='sync-main' checked={!syncMain} onChange={() => setSyncMain(null)} />
                <span>{t('Không đặt')}</span>
              </label>
            </div>
          </div>

          <div className='rcpDeviceHeader'>
            <span className='rcpDeviceTitle'>{t('Device phụ')}</span>
            <label className={`rcpSelectPill${allFollowersChecked ? ' on' : ''}`}>
              <input
                type='checkbox'
                checked={allFollowersChecked}
                onChange={(e) => toggleAllFollowers(e.target.checked)}
              />
              <span className='rcpSelectIcon'>{allFollowersChecked ? '✔' : ''}</span>
              <span className='rcpSelectText'>
                {allFollowersChecked ? t('Deselect all') : t('Select all')}
              </span>
              <span className='rcpSelectCount'>({followerCandidates.length})</span>
            </label>
          </div>
          <div className='rcpGridWrap'>
            <div className='rcpGrid rcpGridCompact'>
              {followerCandidates.map((id) => (
                <label key={id} className={`rcpGridItem${syncTargets.includes(id) ? ' on' : ''}`}>
                  <input type='checkbox' checked={syncTargets.includes(id)} onChange={() => toggleSyncTarget(id)} />
                  <span>{String(idToNumber.get(id) || 0).padStart(2, '0')}</span>
                </label>
              ))}
            </div>
            {!sortedUdids.length ? <div className='rcpHint'>{t('Chưa có device')}</div> : null}
          </div>

          <div className='modalActions'>
            <button className='modalBtn' onClick={() => stopSync()}>
              {t('Dừng sync')}
            </button>
          </div>
        </>
      ) : (
        <div className='rcpHint'>{t('Bật sync để chọn device')}</div>
      )}
    </div>
  );
}
