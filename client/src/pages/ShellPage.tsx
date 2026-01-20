import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { MuxChannel, ascii4 } from '@/lib/multiplexer'

type Props = {
  wsServer: string
  udid: string
}

const buildMultiplexUrl = (wsServer: string): string => {
  const u = new URL(wsServer)
  u.searchParams.set('action', 'multiplex')
  return u.toString()
}

export function ShellPage ({ wsServer, udid }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<string>('')

  useEffect(() => {
    if (!udid) {
      setStatus('Thiếu udid trong URL hash (?#!action=shell&udid=...)')
      return
    }
    const container = containerRef.current
    if (!container) return

    const url = buildMultiplexUrl(wsServer)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    const term = new Terminal({
      fontSize: 14,
      convertEol: true,
      disableStdin: false,
      cursorBlink: true,
      theme: {
        background: '#111',
        foreground: '#e8e8e8'
      }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    term.focus()

    let root: MuxChannel | null = null
    let shellChannel: MuxChannel | null = null

    const sendStart = () => {
      if (!shellChannel || shellChannel.readyState !== shellChannel.OPEN) return
      const dims = fitAddon.proposeDimensions?.() || { rows: 24, cols: 80 }
      const message = {
        id: 1,
        type: 'shell',
        data: {
          type: 'start',
          rows: dims.rows || 24,
          cols: dims.cols || 80,
          udid
        }
      }
      shellChannel.send(JSON.stringify(message))
    }

    const openShellChannel = () => {
      if (!root) return
      const init = ascii4('SHEL')
      shellChannel = root.createChannel(init)
      shellChannel.addEventListener('open', () => {
        setStatus('Kết nối shell qua multiplex…')
        sendStart()
      })
      shellChannel.addEventListener('close', (e: any) => {
        setStatus(`Shell đóng (${e?.code ?? ''} ${e?.reason ?? ''})`)
      })
      shellChannel.addEventListener('message', (ev: any) => {
        if (typeof ev.data === 'string') {
          term.write(ev.data)
        } else if (ev.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(new Uint8Array(ev.data))
          term.write(text)
        }
      })
    }

    ws.onopen = () => {
      setStatus('WS multiplex open, tạo channel SHEL…')
      root = MuxChannel.wrap(ws)
      openShellChannel()
    }
    ws.onerror = () => setStatus('Lỗi websocket. Kiểm tra backend.')
    ws.onclose = e =>
      setStatus(`WS đóng (${e.code}${e.reason ? `: ${e.reason}` : ''})`)

    term.onData(data => {
      if (shellChannel && shellChannel.readyState === shellChannel.OPEN) {
        shellChannel.send(data)
      }
    })

    const onResize = () => {
      try {
        fitAddon.fit()
        sendStart()
      } catch {
        // ignore
      }
    }
    window.addEventListener('resize', onResize, { passive: true })

    return () => {
      window.removeEventListener('resize', onResize)
      try {
        shellChannel?.close()
        ws.close()
      } catch {
        // ignore
      }
      term.dispose()
    }
  }, [wsServer, udid])

  return (
    <div className='hashPage shellPage'>
      <div className='pageHeader'>
        <div className='title'>ADB Shell</div>
        <div className='subtitle'>udid: {udid || 'n/a'}</div>
        {/* {status ? <div className='statusLine'>{status}</div> : null} */}
      </div>
      {/* <div className='shellContainer' ref={containerRef} /> */}
    </div>
  )
}
