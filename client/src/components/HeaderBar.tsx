import React from 'react'
import { useI18n } from '@/context/I18nContext'
import { useServer } from '@/context/ServerContext'
import { useActive } from '@/context/ActiveContext'

type Props = {
  wsServer: string
}

export function HeaderBar ({ wsServer }: Props) {
  const { t, locale, setLocale, available } = useI18n()
  const { androidDevices } = useServer()
  const { syncAll, syncMain, syncTargets, activeUdid } = useActive()
  const logoSrc = 'https://solumate.vn/logo_gold.png'

  const deviceCount = androidDevices.length
  const syncSummary = syncAll
    ? syncMain
      ? `${syncMain} → ${syncTargets.length}`
      : t('Chưa chọn device chính')
    : t('Tắt')

  return (
    <div id='header'>
      <div className='headerLeft'>
        <div className='headerBrand'>
          <img src={logoSrc} alt='Solumate' className='headerLogo' />
          <h1 className='headerGradientTitle'>Solumate</h1>
        </div>
      </div>

      <div className='headerRight'>
        <div className={`headerStat ${syncAll ? 'on' : 'off'}`}>
          <div className='headerStatLabel'>{t('Sync')}</div>
          <div className='headerStatValue'>{syncAll ? t('Bật') : t('Tắt')}</div>
          <div className='headerStatHint'>{syncSummary}</div>
        </div>
        <div className='headerLangWrap'>
          <span className='headerLangLabel'>{t('Ngôn ngữ')}:</span>
          <select
            className='headerLangSelect'
            value={locale}
            onChange={e => setLocale(e.target.value as any)}
          >
            {available.map(code => (
              <option key={code} value={code}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
