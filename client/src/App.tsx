import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import { readPageParams } from '@/lib/params'
import { useServer } from '@/context/ServerContext'
import { Tile } from '@/components/Tile'
import { RightBar } from '@/components/RightBar'
import { STREAM_CONFIG, type StreamConfig } from '@/lib/config'
import { useI18n } from '@/context/I18nContext'
import { HeaderBar } from '@/components/HeaderBar'
import { DeviceViewer } from '@/components/DeviceViewer'
import { useActive } from '@/context/ActiveContext'
import { AndroidKeycode } from '@/lib/keyEvent'
import { SyncPanel } from '@/components/SyncPanel'
import { useTileOrder } from '@/store/useTileOrder'
import {
  ArrowLeft,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  Home,
  Power,
  Menu,
  Volume1,
  Volume2,
  VolumeX
} from 'lucide-react'

type TileDims = { width: number; height: number }

function clamp (n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

const BITRATE_MIN = 524_288
const BITRATE_MAX = 8_388_608
const BITRATE_WARN_THRESHOLD = Math.floor(BITRATE_MAX * 0.6) // ~60%
const VIEWER_STREAM_WIDTH = 1000

type ConnectRequestPayload = {
  device: string
  connect: 'usb' | 'wifi'
  port?: number
}

const CONNECT_API_URL = 'http://127.0.0.1:11000/api/devices/connect'
const CONNECT_CHECK_DEVICE_MESSAGE =
  'Please check that the device is properly plugged into the host'

function sameStreamConfig (a: StreamConfig, b: StreamConfig): boolean {
  return (
    a.bitrate === b.bitrate &&
    a.maxFps === b.maxFps &&
    a.iFrameInterval === b.iFrameInterval &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height &&
    a.sendFrameMeta === b.sendFrameMeta &&
    a.lockedVideoOrientation === b.lockedVideoOrientation &&
    a.displayId === b.displayId
  )
}

export function App () {
  const { t } = useI18n()
  const { deviceParam, wsServer } = useMemo(() => readPageParams(), [])
  const { androidDevices } = useServer()
  const {
    sendKeyTap,
    screenshotActiveCanvas,
    registeredUdids,
    activeUdid,
    selectOnly,
  } = useActive()

  const [streamConfig, setStreamConfig] = useState<StreamConfig>(STREAM_CONFIG)
  const reloadMap = useRef<Map<string, () => void>>(new Map())
  const [viewerUdid, setViewerUdid] = useState<string | null>(null)
  const [viewerOffset, setViewerOffset] = useState({ x: 0, y: 0 })
  const viewerDragRef = useRef({
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    active: false
  })
  const [viewerWidthPx, setViewerWidthPx] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('viewerWidthPx') || '900')
      if (Number.isFinite(saved)) {
        return clamp(saved, 400, 1400)
      }
    } catch {}
    return 900
  })
  const [viewerOverrideConfig, setViewerOverrideConfig] =
    useState<StreamConfig | null>(null)
  const lastViewedRef = useRef<string | null>(null)
  const [draggingTile, setDraggingTile] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [deviceFilter, setDeviceFilter] = useState<'all' | 'usb' | 'wifi'>(
    'all'
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [remoteDevices, setRemoteDevices] = useState<
    Array<{ udid: string; type: 'usb' | 'wifi' | 'unknown' }>
  >([])
  const wsDevicesRef = useRef<WebSocket | null>(null)
  const [connectSelection, setConnectSelection] = useState<Set<string>>(
    () => new Set()
  )
  const [connectModalOpen, setConnectModalOpen] = useState(false)
  const [connectPorts, setConnectPorts] = useState<Record<string, number>>({})
  const [connectBusy, setConnectBusy] = useState(false)
  const targetConnect = deviceFilter === 'wifi' ? 'usb' : 'wifi'
  const connectBtnLabel =
    deviceFilter === 'wifi' ? t('Connect USB') : t('Connect IP')
  const [connectNotification, setConnectNotification] = useState<{
    type: 'success' | 'error'
    text: string
  } | null>(null)
  const [modalPostLoading, setModalPostLoading] = useState(false)
  const modalPostTimerRef = useRef<number | null>(null)

  const formatConnectNotification = useCallback(
    (
      results: Array<{ success?: boolean; error?: string }>,
      connectType: 'usb' | 'wifi',
      attemptCount: number
    ) => {
      const typeLabel = connectType === 'usb' ? 'USB' : 'Wi-Fi'
      const failureHint = t(CONNECT_CHECK_DEVICE_MESSAGE)
      if (!results.length) {
        return {
          type: 'error' as const,
          text: failureHint
        }
      }
      const failed = results.filter(result => !result.success)
      if (!failed.length) {
        return {
          type: 'success' as const,
          text: t('Connected {count} device(s)', { count: results.length })
        }
      }
      const firstError = failed[0].error?.trim()
      return {
        type: 'error' as const,
        text: firstError
          ? `${t('Connect failed for {count} {type} device(s): {error}', {
              count: failed.length,
              type: typeLabel,
              error: firstError
            })} ${failureHint}`
          : `${t('Connect failed for {count} {type} device(s)', {
              count: failed.length,
              type: typeLabel
            })} ${failureHint}`
      }
    },
    [t]
  )

  const runConnectRequest = useCallback(
    async (payload: any[], connectType: 'usb' | 'wifi') => {
      if (!payload.length) return
      setConnectBusy(true)
      setConnectNotification(null)
      try {
        const response = await fetch(CONNECT_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const body = await response.json().catch(() => null)
        if (!response.ok && !body?.results) {
          throw new Error(body?.error ?? t('Connect failed'))
        }
        const results =
          Array.isArray(body?.results) && body.results.length ? body.results : []
        setConnectNotification(
          formatConnectNotification(results, connectType, payload.length)
        )
      } catch (err: any) {
        setConnectNotification({
          type: 'error',
          text: `${t('Connect failed: {error}', {
            error: err?.message ?? t('Connect failed')
          })} ${t(CONNECT_CHECK_DEVICE_MESSAGE)}`
        })
      } finally {
        setConnectBusy(false)
      }
    },
    [formatConnectNotification, t]
  )
  const closeConnectModal = useCallback(() => {
    setConnectModalOpen(false)
    setModalPostLoading(true)
    if (modalPostTimerRef.current) {
      window.clearTimeout(modalPostTimerRef.current)
    }
    modalPostTimerRef.current = window.setTimeout(() => {
      setModalPostLoading(false)
      modalPostTimerRef.current = null
    }, 1300)
  }, [])

  useEffect(() => {
    return () => {
      if (modalPostTimerRef.current) {
        window.clearTimeout(modalPostTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const cls = 'sidebarCollapsed'
    document.body.classList.toggle(cls, sidebarCollapsed)
    const root = document.documentElement
    root.style.setProperty('--config-width', sidebarCollapsed ? '0px' : '320px')
    root.style.setProperty(
      '--sidebar-total',
      sidebarCollapsed ? 'var(--rb-width)' : 'var(--config-width)'
    )
    return () => {
      document.body.classList.remove(cls)
    }
  }, [sidebarCollapsed])

  const registerReload = useCallback((udid: string, fn: () => void) => {
    reloadMap.current.set(udid, fn)
  }, [])

  const unregisterReload = useCallback((udid: string) => {
    reloadMap.current.delete(udid)
  }, [])
  // useEffect(() => {
  //   console.log(viewerOverrideConfig)
  // }, [viewerOverrideConfig])
  const DEFAULT_DIMS: TileDims = { width: 350, height: 700 }

  // Persisted tile size
  const [tileDims, setTileDims] = useState<TileDims>(() => {
    try {
      const saved = localStorage.getItem('deviceDimensions')
      if (!saved) return DEFAULT_DIMS
      const p = JSON.parse(saved)
      const w = clamp(Number(p?.width), 100, 4000)
      const h = clamp(Number(p?.height), 100, 4000)
      return { width: w, height: h }
    } catch {
      return DEFAULT_DIMS
    }
  })

  const tileAspectRef = useRef<number>(
    tileDims.width > 0
      ? tileDims.height / tileDims.width
      : DEFAULT_DIMS.height / DEFAULT_DIMS.width
  )

  const dimsRef = useRef<TileDims>(tileDims)
  useEffect(() => {
    dimsRef.current = tileDims
  }, [tileDims])

  const gridRef = useRef<HTMLDivElement | null>(null)
  const applyDimsToGrid = (d: TileDims) => {
    const el = gridRef.current
    if (!el) return
    el.style.setProperty('--tile-width', `${d.width}px`)
  }

  useEffect(() => {
    applyDimsToGrid(tileDims)
  }, [tileDims])

  const saveTimer = useRef<number | null>(null)
  const scheduleSave = (d: TileDims) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem('deviceDimensions', JSON.stringify(d))
    }, 200)
  }
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  const updateWidth = (w: number) => {
    const width = clamp(w, 100, 4000)
    const height = clamp(Math.round(width * tileAspectRef.current), 100, 4000)
    const next = { width, height }
    dimsRef.current = next
    applyDimsToGrid(next)
    setTileDims(next)
    scheduleSave(next)
  }
  const updateViewerWidthPx = (w: number) => {
    const next = clamp(w, 400, 1400)
    setViewerWidthPx(next)
    try {
      localStorage.setItem('viewerWidthPx', String(next))
    } catch {}
  }

  const discoveredDevices = useMemo(
    () => {
      if (remoteDevices.length) return remoteDevices.map(d => d.udid)
      if (androidDevices.length) return androidDevices.map(d => d.udid)
      return []
    },
    [androidDevices, remoteDevices]
  )
  useEffect(() => {
    const connect = () => {
      try {
        const ws = new WebSocket('ws://localhost:11000/?action=devices-list')
        wsDevicesRef.current = ws
        ws.onmessage = ev => {
          try {
            const payload = JSON.parse(ev.data as string)
            if (Array.isArray(payload)) {
              const dedup = new Map<string, { udid: string; type: 'usb' | 'wifi' | 'unknown' }>()
              payload.forEach((d: any) => {
                const device = String(d?.device || '').trim()
                const key = String(d?.uuid || device).trim()
                if (!device || !key) return
                const ct = String(d?.connect_type || '').toLowerCase()
                let type: 'usb' | 'wifi' | 'unknown' = 'unknown'
                if (ct.includes('wifi')) type = 'wifi'
                else if (ct.includes('usb')) type = 'usb'
                else if (device.includes(':')) type = 'wifi'
                dedup.set(key, { udid: device, type })
              })
              const mapped = Array.from(dedup.values())
              startTransition(() => setRemoteDevices(mapped))
            }
          } catch {
            // ignore parse errors
          }
        }
        ws.onclose = () => {
          wsDevicesRef.current = null
        }
        ws.onerror = () => {
          ws.close()
        }
      } catch {
        // ignore
      }
    }
    connect()
    return () => {
      wsDevicesRef.current?.close()
      wsDevicesRef.current = null
    }
  }, [])

  useEffect(() => {
    // Reset selection when switching filter to avoid cross-filter confusion
    setConnectSelection(new Set())
    setConnectBusy(false)
  }, [deviceFilter])
  const connectionTypeByUdid = useMemo(() => {
    const map = new Map<string, 'usb' | 'wifi' | 'unknown'>()
    remoteDevices.forEach(d => {
      if (d.udid) map.set(d.udid, d.type)
    })
    androidDevices.forEach(d => {
      const ifaceNames = d.interfaces?.map(i => i.name.toLowerCase()) || []
      const hasWifiIface = ifaceNames.some(
        n => n.includes('wlan') || n.includes('wifi') || n.includes('wl')
      )
      const hasUsbIface = ifaceNames.some(
        n => n.includes('usb') || n.includes('rndis')
      )
      let type: 'usb' | 'wifi' | 'unknown' = 'unknown'
      if (hasWifiIface) type = 'wifi'
      else if (hasUsbIface) type = 'usb'
      else if (d.udid.includes(':')) type = 'wifi'
      else type = 'usb'
      map.set(d.udid, type)
    })
    return map
  }, [androidDevices, remoteDevices])
  const getDeviceConnectionType = useCallback(
    (udid: string): 'usb' | 'wifi' | 'unknown' => {
      const known = connectionTypeByUdid.get(udid)
      if (known) return known
      if (udid.includes(':')) return 'wifi'
      return 'usb'
    },
    [connectionTypeByUdid]
  )

  const gridDevices = useMemo(() => {
    if (deviceParam) return [deviceParam]
    if (discoveredDevices.length) return discoveredDevices
    return []
  }, [deviceParam, discoveredDevices])
  const filteredGridDevices = useMemo(() => {
    if (deviceFilter === 'all') return gridDevices
    return gridDevices.filter(
      id => getDeviceConnectionType(id) === deviceFilter
    )
  }, [deviceFilter, gridDevices, getDeviceConnectionType])
  const { mergedOrder, moveTile } = useTileOrder(filteredGridDevices)
  const filteredRegistered = useMemo(() => {
    return registeredUdids.filter(id => {
      if (deviceFilter === 'all') return true
      const type = getDeviceConnectionType(id)
      return type === deviceFilter
    })
  }, [registeredUdids, deviceFilter, getDeviceConnectionType])
  const orderMap = useMemo(() => {
    const m = new Map<string, number>()
    mergedOrder.forEach((id, idx) => m.set(id, idx + 1))
    return m
  }, [mergedOrder])
  const orderedRegistered = useMemo(() => {
    const arr = [...filteredRegistered]
    arr.sort((a, b) => {
      const oa = orderMap.get(a) ?? Number.MAX_SAFE_INTEGER
      const ob = orderMap.get(b) ?? Number.MAX_SAFE_INTEGER
      return oa - ob
    })
    return arr
  }, [filteredRegistered, orderMap])
  const selectedVisible = useMemo(
    () => orderedRegistered.filter(id => connectSelection.has(id)),
    [orderedRegistered, connectSelection]
  )
  const allSelected =
    orderedRegistered.length > 0 &&
    orderedRegistered.every(id => connectSelection.has(id))
  const isSingleDevice = gridDevices.length === 1

  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const dragState = useRef({
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    active: false
  })
  const [dragging, setDragging] = useState(false)

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragState.current.active) return
    e.preventDefault()
    const dx = e.clientX - dragState.current.startX
    const dy = e.clientY - dragState.current.startY
    setDragOffset({
      x: dragState.current.originX + dx,
      y: dragState.current.originY + dy
    })
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragState.current.active) return
    dragState.current.active = false
    setDragging(false)
    window.removeEventListener('pointermove', onPointerMove as any)
    window.removeEventListener('pointerup', onPointerUp as any)
  }, [onPointerMove])

  const onTilePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isSingleDevice) return
      if (e.button !== 0) return
      const targetEl = e.target as HTMLElement | null
      const handle = targetEl?.closest('.tileDragHandle')
      if (!handle) return
      e.preventDefault()
      dragState.current.startX = e.clientX
      dragState.current.startY = e.clientY
      dragState.current.originX = dragOffset.x
      dragState.current.originY = dragOffset.y
      dragState.current.active = true
      setDragging(true)
      window.addEventListener('pointermove', onPointerMove as any, {
        passive: false
      })
      window.addEventListener('pointerup', onPointerUp as any)
    },
    [dragOffset.x, dragOffset.y, isSingleDevice, onPointerMove, onPointerUp]
  )

  useEffect(() => {
    if (!isSingleDevice) {
      setDragOffset({ x: 0, y: 0 })
      setDragging(false)
    }
    return () => {
      window.removeEventListener('pointermove', onPointerMove as any)
      window.removeEventListener('pointerup', onPointerUp as any)
    }
  }, [isSingleDevice, onPointerMove, onPointerUp])

  const [draftConfig, setDraftConfig] = useState<StreamConfig>(STREAM_CONFIG)
  // Track aspect ratio so stream height follows width
  const boundsAspectRef = useRef<number>(
    STREAM_CONFIG.bounds.height && STREAM_CONFIG.bounds.width
      ? STREAM_CONFIG.bounds.height / STREAM_CONFIG.bounds.width
      : 1
  )
  const autoApplyTimer = useRef<number | null>(null)
  const skipNextAutoApply = useRef(false)
  const [bitrateWarnAccepted, setBitrateWarnAccepted] = useState(false)
  const [bitrateConfirmVisible, setBitrateConfirmVisible] = useState(false)
  const [bitratePending, setBitratePending] = useState<number | null>(null)
  const [bitrateNeedsConfirm, setBitrateNeedsConfirm] = useState(false)
  const [bitrateLastSafe, setBitrateLastSafe] = useState<number>(
    STREAM_CONFIG.bitrate
  )
  const bitrateDragRef = useRef(false)

  useEffect(() => {
    setDraftConfig(streamConfig)
    const w = streamConfig.bounds.width || 1
    const h = streamConfig.bounds.height || 1
    boundsAspectRef.current = h / w
    skipNextAutoApply.current = true
    setBitrateWarnAccepted(false)
    setBitrateConfirmVisible(false)
    setBitratePending(null)
    setBitrateNeedsConfirm(false)
    setBitrateLastSafe(streamConfig.bitrate)
    bitrateDragRef.current = false
  }, [streamConfig])

  const normalizeStreamConfig = (cfg: StreamConfig): StreamConfig => {
    const bitrate = clamp(cfg.bitrate, 524288, 8_388_608)
    const maxFps = clamp(cfg.maxFps, 1, 60)
    const iFrameInterval = clamp(cfg.iFrameInterval, 0, 60)
    const width = clamp(cfg.bounds?.width ?? 0, 400, 1200)
    const height = clamp(cfg.bounds?.height ?? 0, 400, 4000)
    const lockedVideoOrientation = Math.max(
      -1,
      Math.min(3, Math.floor(cfg.lockedVideoOrientation ?? -1))
    )
    const displayId = Math.max(0, Math.floor(cfg.displayId ?? 0))
    return {
      bitrate,
      maxFps,
      iFrameInterval,
      bounds: { width, height },
      sendFrameMeta: Boolean(cfg.sendFrameMeta),
      lockedVideoOrientation,
      displayId
    }
  }

  const buildViewerConfig = useCallback((base: StreamConfig): StreamConfig => {
    const width = clamp(VIEWER_STREAM_WIDTH, 400, 1200)
    const aspect =
      base.bounds?.width && base.bounds?.height
        ? base.bounds.height / base.bounds.width
        : boundsAspectRef.current || 1
    const height = clamp(Math.round(width * aspect), 400, 4000)
    return {
      ...base,
      bounds: { width, height },
      bitrate: 8_388_608,
      maxFps: 60
    }
  }, [])

  // When switching viewer device, reset offset and apply per-viewer config; when closing, revert and reload tile.
  useEffect(() => {
    const prevViewed = lastViewedRef.current
    if (viewerUdid) {
      lastViewedRef.current = viewerUdid
      setViewerOffset({ x: 0, y: 0 })
      const nextCfg = buildViewerConfig(streamConfig)
      setViewerOverrideConfig(prev =>
        prev && sameStreamConfig(prev, nextCfg) ? prev : nextCfg
      )
    } else {
      setViewerOverrideConfig(prev => (prev ? null : prev))
      if (prevViewed) {
        const fn = reloadMap.current.get(prevViewed)
        try {
          fn?.()
        } catch {}
      }
      lastViewedRef.current = null
    }
  }, [viewerUdid, streamConfig, buildViewerConfig])

  const updateBoundsWidth = (widthRaw: number) => {
    const width = clamp(widthRaw, 400, 1200)
    const height = Math.max(1, Math.round(width * boundsAspectRef.current))
    setDraftConfig(prev => ({
      ...prev,
      bounds: { width, height }
    }))
  }

  const reloadAllTiles = useCallback(() => {
    reloadMap.current.forEach(fn => {
      try {
        fn?.()
      } catch {
        // ignore
      }
    })
  }, [])

  useEffect(() => {
    if (viewerUdid && viewerOverrideConfig) {
      const fn = reloadMap.current.get(viewerUdid)
      try {
        fn?.()
      } catch {}
    }
  }, [viewerOverrideConfig, viewerUdid])

  const applyDraftConfig = useCallback(() => {
    const next = normalizeStreamConfig(draftConfig)
    setStreamConfig(prev => {
      if (sameStreamConfig(prev, next)) return prev
      reloadAllTiles()
      return next
    })
  }, [draftConfig, reloadAllTiles])

  const handleBitrateChange = (val: number) => {
    const needsConfirm = val > BITRATE_WARN_THRESHOLD && !bitrateWarnAccepted
    if (needsConfirm) {
      setBitrateNeedsConfirm(true)
      setBitratePending(val)
    } else {
      setBitrateNeedsConfirm(false)
      setBitratePending(null)
      setBitrateLastSafe(val)
    }
    setDraftConfig(prev => ({ ...prev, bitrate: val }))
  }

  const onBitratePointerDown = () => {
    bitrateDragRef.current = true
  }

  const onBitratePointerUp = () => {
    const needsConfirm = bitrateNeedsConfirm && !bitrateWarnAccepted
    bitrateDragRef.current = false
    if (needsConfirm) {
      setBitrateConfirmVisible(true)
    }
  }

  // Auto-apply on slider changes with debounce to avoid spamming reconnects
  useEffect(() => {
    if (skipNextAutoApply.current) {
      skipNextAutoApply.current = false
      return
    }
    if (
      (bitrateNeedsConfirm && !bitrateWarnAccepted) ||
      bitrateConfirmVisible
    ) {
      return
    }
    if (autoApplyTimer.current) window.clearTimeout(autoApplyTimer.current)
    autoApplyTimer.current = window.setTimeout(() => {
      applyDraftConfig()
      autoApplyTimer.current = null
    }, 600)
    return () => {
      if (autoApplyTimer.current) {
        window.clearTimeout(autoApplyTimer.current)
        autoApplyTimer.current = null
      }
    }
  }, [
    draftConfig,
    applyDraftConfig,
    bitrateNeedsConfirm,
    bitrateWarnAccepted,
    bitrateConfirmVisible
  ])

  const onViewerPointerMove = useCallback((e: PointerEvent) => {
    if (!viewerDragRef.current.active) return
    e.preventDefault()
    const dx = e.clientX - viewerDragRef.current.startX
    const dy = e.clientY - viewerDragRef.current.startY
    setViewerOffset({
      x: viewerDragRef.current.originX + dx,
      y: viewerDragRef.current.originY + dy
    })
  }, [])

  const onViewerPointerUp = useCallback(() => {
    if (!viewerDragRef.current.active) return
    viewerDragRef.current.active = false
    window.removeEventListener('pointermove', onViewerPointerMove as any)
    window.removeEventListener('pointerup', onViewerPointerUp as any)
  }, [onViewerPointerMove])

  const onViewerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const targetEl = e.target as HTMLElement | null
      const isHeader = targetEl?.closest('.viewerHeader')
      const isActions = targetEl?.closest('.viewerActions')
      const isActionBtn = targetEl?.closest('.viewerActionBtn')
      const isHandle = isHeader || (isActions && !isActionBtn)
      if (!isHandle) return
      e.preventDefault()
      viewerDragRef.current.startX = e.clientX
      viewerDragRef.current.startY = e.clientY
      viewerDragRef.current.originX = viewerOffset.x
      viewerDragRef.current.originY = viewerOffset.y
      viewerDragRef.current.active = true
      window.addEventListener('pointermove', onViewerPointerMove as any, {
        passive: false
      })
      window.addEventListener('pointerup', onViewerPointerUp as any)
    },
    [viewerOffset.x, viewerOffset.y, onViewerPointerMove, onViewerPointerUp]
  )

  return (
    <>
      <HeaderBar wsServer={wsServer} />
      <div id='main'>
        <div id='gridScroll'>
          <div
            id='grid'
            className={isSingleDevice ? 'singleMode' : undefined}
            ref={gridRef}
            style={
              {
                ['--tile-width' as any]: `${tileDims.width}px`,
                ['--grid-gap' as any]: '8px',
                ['--grid-width' as any]: '100%'
              } as React.CSSProperties
            }
          >
            {mergedOrder.map((udid, idx) => (
              <div
                key={udid}
                className={`tileDraggableWrapper${
                  isSingleDevice ? ' single' : ''
                }${dragging ? ' dragging' : ''}${
                  viewerUdid === udid ? ' hiddenByViewer' : ''
                }${dropTarget === udid ? ' dropTarget' : ''}`}
                onPointerDown={onTilePointerDown}
                onDragOver={e => {
                  if (draggingTile) e.preventDefault()
                  if (draggingTile && dropTarget !== udid) {
                    setDropTarget(udid)
                  }
                  if (draggingTile && draggingTile !== udid) {
                    const toIndex = mergedOrder.indexOf(udid)
                    const fromIndex = mergedOrder.indexOf(draggingTile)
                    if (
                      toIndex >= 0 &&
                      fromIndex >= 0 &&
                      toIndex !== fromIndex
                    ) {
                      moveTile(draggingTile, toIndex)
                    }
                  }
                }}
                onDrop={e => {
                  e.preventDefault()
                  if (draggingTile) {
                    const toIndex = mergedOrder.indexOf(udid)
                    if (toIndex >= 0) moveTile(draggingTile, toIndex)
                    setDraggingTile(null)
                  }
                  setDropTarget(null)
                }}
                onDragLeave={() => {
                  setDropTarget(prev => (prev === udid ? null : prev))
                }}
                style={
                  isSingleDevice
                    ? {
                        ['--drag-x' as any]: `${dragOffset.x}px`,
                        ['--drag-y' as any]: `${dragOffset.y}px`
                      }
                    : undefined
                }
              >
                  <Tile
                    udid={udid}
                    order={idx + 1}
                    deviceParam={udid}
                    wsServer={wsServer}
                    isViewing={viewerUdid === udid}
                    selected={connectSelection.has(udid)}
                    streamConfig={
                      viewerUdid === udid && viewerOverrideConfig
                        ? viewerOverrideConfig
                        : streamConfig
                  }
                  onRegisterReload={registerReload}
                  onUnregisterReload={unregisterReload}
                  onViewDevice={id => {
                    setViewerUdid(id)
                  }}
                  onMove={moveTile}
                  onDragStart={id => setDraggingTile(id)}
                  onDragEnd={() => setDraggingTile(null)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <RightBar
        hidden={!sidebarCollapsed}
        showExpand={sidebarCollapsed}
        hideSyncButtons={sidebarCollapsed}
        onExpand={() => setSidebarCollapsed(false)}
      />
      <div
        className={`rightConfigPanel${sidebarCollapsed ? ' collapsed' : ''}`}
      >
        <button
          className='rcpCollapseBtn'
          aria-label={sidebarCollapsed ? t('Mở rộng') : t('Thu gọn')}
          onClick={() => setSidebarCollapsed(true)}
        >
          {sidebarCollapsed ? (
            <ChevronsLeft size={18} strokeWidth={2} />
          ) : (
            <ChevronsRight size={18} strokeWidth={2} />
          )}
        </button>
        <div className='rcpContent'>
          <div className='rcpSection'>
            <div className='rcpTitle'>{t('Tile size')}</div>
            <div className='rcpSliderRow'>
              <div className='rcpSliderLabel'>{t('Large size')}</div>
              <button
                className='rcpStepBtn'
                aria-label={t('Decrease tile width')}
                onClick={() => updateWidth(tileDims.width - 5)}
              >
                –
              </button>
              <input
                type='range'
                min='150'
                max='2000'
                value={tileDims.width}
                onChange={e => updateWidth(Number(e.target.value))}
                className='modalRange'
              />
              <button
                className='rcpStepBtn'
                aria-label={t('Increase tile width')}
                onClick={() => updateWidth(tileDims.width + 5)}
              >
                +
              </button>
              <div className='rcpValue'>{tileDims.width}px</div>
            </div>
            {viewerUdid ? (
              <div className='rcpSliderRow'>
                <div className='rcpSliderLabel'>{t('Viewer width')}</div>
                <button
                  className='rcpStepBtn'
                  aria-label={t('Decrease viewer width')}
                  onClick={() => updateViewerWidthPx(viewerWidthPx - 20)}
                >
                  –
                </button>
                <input
                  type='range'
                  min='400'
                  max='1400'
                  value={viewerWidthPx}
                  onChange={e => updateViewerWidthPx(Number(e.target.value))}
                  className='modalRange'
                />
                <button
                  className='rcpStepBtn'
                  aria-label={t('Increase viewer width')}
                  onClick={() => updateViewerWidthPx(viewerWidthPx + 20)}
                >
                  +
                </button>
                <div className='rcpValue'>{viewerWidthPx}px</div>
              </div>
            ) : null}
            <div className='rcpHint'>
              {t('Tile height: {height}px (Auto from width)', {
                height: tileDims.height
              })}
            </div>
          </div>

          <div className='rcpSection'>
            <div className='rcpTitle'>
              {viewerUdid ? t('Stream config (viewer)') : t('Stream config')}
            </div>
            <div className='rcpSliderRow'>
              <div className='rcpSliderLabel'>Bitrate</div>
              <button
                className='rcpStepBtn'
                aria-label={t('Decrease bitrate')}
                onClick={() => {
                  const delta = -131072
                  if (viewerUdid && viewerOverrideConfig) {
                    const next = clamp(
                      (viewerOverrideConfig?.bitrate || 0) + delta,
                      BITRATE_MIN,
                      BITRATE_MAX
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, bitrate: next } : prev
                    )
                  } else {
                    handleBitrateChange(
                      clamp(
                        draftConfig.bitrate + delta,
                        BITRATE_MIN,
                        BITRATE_MAX
                      )
                    )
                  }
                }}
              >
                –
              </button>
              <input
                type='range'
                min={BITRATE_MIN}
                max={BITRATE_MAX}
                step='131072'
                value={
                  viewerUdid && viewerOverrideConfig
                    ? viewerOverrideConfig.bitrate
                    : draftConfig.bitrate
                }
                onChange={e =>
                  viewerUdid && viewerOverrideConfig
                    ? setViewerOverrideConfig(prev =>
                        prev
                          ? { ...prev, bitrate: Number(e.target.value) }
                          : prev
                      )
                    : handleBitrateChange(Number(e.target.value))
                }
                onMouseDown={onBitratePointerDown}
                onTouchStart={onBitratePointerDown}
                onMouseUp={onBitratePointerUp}
                onTouchEnd={onBitratePointerUp}
                onMouseLeave={onBitratePointerUp}
                className='modalRange'
              />
              <button
                className='rcpStepBtn'
                aria-label={t('Increase bitrate')}
                onClick={() => {
                  const delta = 131072
                  if (viewerUdid && viewerOverrideConfig) {
                    const next = clamp(
                      (viewerOverrideConfig?.bitrate || 0) + delta,
                      BITRATE_MIN,
                      BITRATE_MAX
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, bitrate: next } : prev
                    )
                  } else {
                    handleBitrateChange(
                      clamp(
                        draftConfig.bitrate + delta,
                        BITRATE_MIN,
                        BITRATE_MAX
                      )
                    )
                  }
                }}
              >
                +
              </button>
              <div className='rcpValue'>
                {(viewerUdid && viewerOverrideConfig
                  ? viewerOverrideConfig.bitrate
                  : draftConfig.bitrate
                ).toLocaleString()}
              </div>
            </div>
            <div className='rcpSliderRow'>
              <div className='rcpSliderLabel'>FPS</div>
              <button
                className='rcpStepBtn'
                aria-label={t('Decrease FPS')}
                onClick={() => {
                  if (viewerUdid && viewerOverrideConfig) {
                    const next = clamp(
                      (viewerOverrideConfig?.maxFps || 1) - 1,
                      1,
                      60
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, maxFps: next } : prev
                    )
                  } else {
                    setDraftConfig(prev => ({
                      ...prev,
                      maxFps: clamp(prev.maxFps - 1, 1, 60)
                    }))
                  }
                }}
              >
                –
              </button>
              <input
                type='range'
                min='1'
                max='60'
                value={
                  viewerUdid && viewerOverrideConfig
                    ? viewerOverrideConfig.maxFps
                    : draftConfig.maxFps
                }
                onChange={e =>
                  viewerUdid && viewerOverrideConfig
                    ? setViewerOverrideConfig(prev =>
                        prev
                          ? { ...prev, maxFps: Number(e.target.value) }
                          : prev
                      )
                    : setDraftConfig(prev => ({
                        ...prev,
                        maxFps: Number(e.target.value)
                      }))
                }
                className='modalRange'
              />
              <button
                className='rcpStepBtn'
                aria-label={t('Increase FPS')}
                onClick={() => {
                  if (viewerUdid && viewerOverrideConfig) {
                    const next = clamp(
                      (viewerOverrideConfig?.maxFps || 1) + 1,
                      1,
                      60
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, maxFps: next } : prev
                    )
                  } else {
                    setDraftConfig(prev => ({
                      ...prev,
                      maxFps: clamp(prev.maxFps + 1, 1, 60)
                    }))
                  }
                }}
              >
                +
              </button>
              <div className='rcpValue'>
                {viewerUdid && viewerOverrideConfig
                  ? viewerOverrideConfig.maxFps
                  : draftConfig.maxFps}{' '}
                fps
              </div>
            </div>

            <div className='rcpSliderRow'>
              <div className='rcpSliderLabel'>{t('Stream width')}</div>
              <button
                className='rcpStepBtn'
                aria-label={t('Decrease stream width')}
                onClick={() => {
                  if (viewerUdid && viewerOverrideConfig) {
                    const w = clamp(
                      (viewerOverrideConfig?.bounds?.width || 400) - 20,
                      400,
                      1200
                    )
                    const h = Math.max(
                      1,
                      Math.round(w * boundsAspectRef.current)
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, bounds: { width: w, height: h } } : prev
                    )
                  } else {
                    updateBoundsWidth(draftConfig.bounds.width - 20)
                  }
                }}
              >
                –
              </button>
              <input
                type='range'
                min='400'
                max='1200'
                value={
                  viewerUdid && viewerOverrideConfig
                    ? viewerOverrideConfig.bounds.width
                    : draftConfig.bounds.width
                }
                onChange={e => {
                  if (viewerUdid && viewerOverrideConfig) {
                    const w = clamp(Number(e.target.value), 400, 1200)
                    const h = Math.max(
                      1,
                      Math.round(w * boundsAspectRef.current)
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, bounds: { width: w, height: h } } : prev
                    )
                  } else {
                    updateBoundsWidth(Number(e.target.value))
                  }
                }}
                className='modalRange'
              />
              <button
                className='rcpStepBtn'
                aria-label={t('Increase stream width')}
                onClick={() => {
                  if (viewerUdid && viewerOverrideConfig) {
                    const w = clamp(
                      (viewerOverrideConfig?.bounds?.width || 400) + 20,
                      400,
                      1200
                    )
                    const h = Math.max(
                      1,
                      Math.round(w * boundsAspectRef.current)
                    )
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, bounds: { width: w, height: h } } : prev
                    )
                  } else {
                    updateBoundsWidth(draftConfig.bounds.width + 20)
                  }
                }}
              >
                +
              </button>
              <div className='rcpValue'>
                {viewerUdid && viewerOverrideConfig
                  ? viewerOverrideConfig.bounds.width
                  : draftConfig.bounds.width}
                px
              </div>
            </div>

            <label className='modalLabel'>
              {t('Rotation lock:')}
              <select
                className='cp-select'
                value={
                  viewerUdid && viewerOverrideConfig
                    ? viewerOverrideConfig.lockedVideoOrientation
                    : draftConfig.lockedVideoOrientation
                }
                onChange={e => {
                  const val = Number(e.target.value)
                  if (viewerUdid && viewerOverrideConfig) {
                    setViewerOverrideConfig(prev =>
                      prev ? { ...prev, lockedVideoOrientation: val } : prev
                    )
                  } else {
                    setDraftConfig(prev => ({
                      ...prev,
                      lockedVideoOrientation: val
                    }))
                  }
                }}
                style={{ marginLeft: 8 }}
              >
                <option value={-1}>Auto</option>
                <option value={0}>0°</option>
                <option value={1}>90°</option>
                <option value={2}>180°</option>
                <option value={3}>270°</option>
              </select>
            </label>

            <div className='modalActions'>
              <button
                className='modalBtn'
                onClick={() => {
                  if (viewerUdid && viewerOverrideConfig) {
                    setViewerOverrideConfig(streamConfig)
                  } else {
                    setDraftConfig(STREAM_CONFIG)
                  }
                }}
              >
                {t('Reset to default')}
              </button>
            </div>
          </div>

          <div className='rcpSection'>
            <div className='rcpTitle'>{t('Điều khiển nhanh')}</div>
            <div className='rcpActions'>
              <button
                className='rcpBtn'
                title={t('Nguồn')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_POWER)}
              >
                <Power size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Tăng âm lượng')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_VOLUME_UP)}
              >
                <Volume2 size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Giảm âm lượng')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_VOLUME_DOWN)}
              >
                <Volume1 size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Tắt tiếng')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_VOLUME_MUTE)}
              >
                <VolumeX size={16} strokeWidth={1.8} />
              </button>
            </div>
            <div className='rcpActions'>
              <button
                className='rcpBtn'
                title={t('Quay lại')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_BACK)}
              >
                <ArrowLeft size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Về Home')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_HOME)}
              >
                <Home size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Đa nhiệm')}
                onClick={() => sendKeyTap(AndroidKeycode.KEYCODE_APP_SWITCH)}
              >
                <Menu size={16} strokeWidth={1.8} />
              </button>
              <button
                className='rcpBtn'
                title={t('Chụp màn hình')}
                onClick={() => screenshotActiveCanvas()}
              >
                <Camera size={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          <SyncPanel orderedUdids={mergedOrder} />

          <div className='rcpSection rcpDevicePanel'>
            <div className='rcpTabsRow rcpSegment'>
              <button className='rcpTab active'>{t('Local')}</button>
            </div>
            <div className='rcpFilters rcpFiltersCompact'>
              <button
                className={`rcpFilter${
                  deviceFilter === 'all' ? ' active' : ''
                }`}
                onClick={() => setDeviceFilter('all')}
              >
                {t('All')}
              </button>
              <button
                className={`rcpFilter${
                  deviceFilter === 'usb' ? ' active' : ''
                }`}
                onClick={() => setDeviceFilter('usb')}
              >
                USB
              </button>
              <button
                className={`rcpFilter${
                  deviceFilter === 'wifi' ? ' active' : ''
                }`}
                onClick={() => setDeviceFilter('wifi')}
              >
                WIFI
              </button>
            </div>
            <div className='rcpDeviceSection'>
              <div className='rcpDeviceHeader rcpDeviceHeaderTop'>
                <span className='rcpDeviceTitle'>{t('Device tags')}</span>
                <button
                  className={`rcpSelectPill${allSelected ? ' on' : ''}`}
                  onClick={() => {
                    setConnectSelection(prev => {
                      const next = new Set(prev)
                      if (allSelected) {
                        filteredRegistered.forEach(id => next.delete(id))
                      } else {
                        filteredRegistered.forEach(id => next.add(id))
                      }
                      return next
                    })
                  }}
                >
                  <span className='rcpSelectIcon'>{allSelected ? '✔' : ''}</span>
                  <span className='rcpSelectText'>
                    {allSelected ? t('Deselect all') : t('Select all')}
                    </span>
                    <span className='rcpSelectCount'>({filteredRegistered.length})</span>
                </button>
              </div>
              <div className='rcpDeviceToolbar'>
                {deviceFilter !== 'all' ? (
                  <button
                    className='rcpAdd'
                    disabled={!connectSelection.size || connectBusy}
                  onClick={() => {
                    if (!selectedVisible.length) return
                    if (targetConnect === 'wifi') {
                      const nextPorts: Record<string, number> = {}
                      selectedVisible.forEach(id => {
                        const hasPort = id.includes(':')
                        const port = hasPort ? Number(id.split(':').pop()) : 5555
                        nextPorts[id] = Number.isFinite(port) ? port : 5555
                      })
                      setConnectPorts(nextPorts)
                      setConnectModalOpen(true)
                    } else {
                      const payload = selectedVisible.map(id => ({
                        device: id,
                        connect: 'usb'
                      }))
                      runConnectRequest(payload, targetConnect)
                    }
                  }}
                >
                  {connectBtnLabel}
                </button>
              ) : null}
              <button className='rcpAdd ghost'>{t('Add tag')}</button>
            </div>
            {connectNotification ? (
              <div className={`rcpConnectNotification ${connectNotification.type}`}>
                {connectNotification.text}
              </div>
            ) : null}
            <div className='rcpDeviceList'>
                  {orderedRegistered.length ? (
                    orderedRegistered.map(id => (
                      <label
                        key={id}
                        className={`rcpDeviceRow${connectSelection.has(id) ? ' selected' : ''}${
                          activeUdid === id ? ' activeDevice' : ''
                        }`}
                        onClick={(e: React.MouseEvent<HTMLLabelElement>) => {
                          const target = e.target as HTMLElement
                          if (target.closest('input')) return
                          selectOnly(id)
                        }}
                      >
                        <input
                          type='checkbox'
                          checked={connectSelection.has(id)}
                          onChange={e => {
                            setConnectSelection(prev => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(id)
                              else next.delete(id)
                              return next
                            })
                          }}
                        />
                        <span className='rcpDeviceText'>
                          <span className='rcpDeviceOrder'>
                            {String(orderMap.get(id) ?? 0).padStart(2, '0')}
                          </span>
                          <span className='rcpDeviceLabel'>{id}</span>
                        </span>
                      </label>
                    ))
                ) : (
                  <div className='rcpHint'>{t('Chưa có device')}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {viewerUdid ? (
        <div
          className='viewerOverlay'
          onMouseDown={() => {
            setViewerUdid(null)
            setViewerOverrideConfig(null)
          }}
        >
          <div
            className='viewerOverlayPanelWrap'
            style={
              {
                ['--viewer-dx' as any]: `${viewerOffset.x}px`,
                ['--viewer-dy' as any]: `${viewerOffset.y}px`,
                ['--viewer-width' as any]: `${viewerWidthPx}px`
              } as React.CSSProperties
            }
            onMouseDown={e => e.stopPropagation()}
            onPointerDown={onViewerPointerDown}
          >
            <div className='viewerOverlayPanel'>
              <DeviceViewer
                udid={viewerUdid}
                wsServer={wsServer}
                onClose={() => setViewerUdid(null)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {bitrateConfirmVisible ? (
        <div
          className='confirmOverlay'
          onMouseDown={() => setBitrateConfirmVisible(false)}
        >
          <div className='confirmPanel' onMouseDown={e => e.stopPropagation()}>
            <div className='confirmTitle'>{t('Bitrate cao')}</div>
            <div className='confirmText'>
              {t(
                'Kéo bitrate cao trên (60%) có thể làm tăng tải và đôi lúc gây giật/đứt stream. Vẫn tiếp tục?'
              )}
            </div>
            <div className='confirmActions'>
              <button
                className='modalBtn'
                onClick={() => {
                  setBitrateConfirmVisible(false)
                  setBitratePending(null)
                  setBitrateNeedsConfirm(false)
                  setDraftConfig(prev => ({
                    ...prev,
                    bitrate: bitrateLastSafe
                  }))
                }}
              >
                {t('Hủy')}
              </button>
              <button
                className='modalBtnPrimary'
                onClick={() => {
                  const target = bitratePending ?? draftConfig.bitrate
                  setBitrateWarnAccepted(true)
                  setBitrateConfirmVisible(false)
                  setBitrateNeedsConfirm(false)
                  setBitratePending(null)
                  setBitrateLastSafe(target)
                  setDraftConfig(prev => ({ ...prev, bitrate: target }))
                  applyDraftConfig()
                }}
              >
                {t('Tiếp tục')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {connectModalOpen ? (
        <div className='confirmOverlay' onMouseDown={closeConnectModal}>
          <div className='confirmPanel' onMouseDown={e => e.stopPropagation()}>
            <div className='confirmTitle'>{t('Connect devices')}</div>
                {targetConnect === 'wifi' ? (
                  <>
                    <div className='confirmText'>
                      {t('Set port (default 5555) for each device')}
                    </div>
                    <div className='connectList'>
                      {selectedVisible.map(id => (
                        <div key={id} className='connectRow'>
                          <div className='connectId'>{id}</div>
                          <input
                        className='connectPort'
                        type='number'
                        min={1}
                        max={65535}
                        value={connectPorts[id] ?? 5555}
                        onChange={e =>
                          setConnectPorts(prev => ({
                            ...prev,
                            [id]: Number(e.target.value) || 5555
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className='connectList'>
                {Array.from(connectSelection).map(id => (
                  <div key={id} className='connectRow'>
                    <div className='connectId'>{id}</div>
                  </div>
                ))}
              </div>
            )}
            <div className='confirmActions'>
              <button className='modalBtn' onClick={closeConnectModal}>
                {t('Cancel')}
              </button>
            <button
              className='modalBtnPrimary'
              disabled={connectBusy}
              onClick={async () => {
                const payload = Array.from(connectSelection).map(id => {
                  const port = connectPorts[id] ?? 5555
                  return targetConnect === 'wifi'
                    ? { device: id, connect: 'wifi', port }
                    : { device: id, connect: 'usb' }
                })
                await runConnectRequest(payload, targetConnect)
                closeConnectModal()
              }}
            >
                {t('Save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {modalPostLoading ? (
        <div className='rcpModalCloseLoading'>
          <div className='rcpModalLoader' aria-hidden='true'></div>
          <span>{t('Loading…')}</span>
        </div>
      ) : null}
    </>
  )
}
