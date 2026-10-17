import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'

interface Props {
  sessionId: string
  alive: boolean
}

/** A real terminal attached to one session's pty. Replays scrollback on open. */
export function TerminalView({ sessionId, alive }: Props) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#120f1c',
        foreground: '#eadfc8',
        cursor: '#ffd26a',
        selectionBackground: '#4a3a6b',
        black: '#1a1424',
        red: '#e05a3a',
        green: '#7bc96f',
        yellow: '#ffd26a',
        blue: '#6fa8e0',
        magenta: '#c288e0',
        cyan: '#5fc9c0',
        white: '#eadfc8',
        brightBlack: '#5a5068',
        brightRed: '#ff7a5a',
        brightGreen: '#9fe08f',
        brightYellow: '#ffe39a',
        brightBlue: '#8fc0ff',
        brightMagenta: '#dca8ff',
        brightCyan: '#8fe8e0',
        brightWhite: '#fff8ea'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    let disposed = false
    const doFit = () => {
      if (disposed) return
      try {
        fit.fit()
        api.sessions.resize(sessionId, term.cols, term.rows)
      } catch {
        /* element hidden */
      }
    }

    void api.sessions.scrollback(sessionId).then((data) => {
      if (disposed) return
      if (data) term.write(data)
      doFit()
      term.focus()
    })

    const offData = api.sessions.onData((id, data) => {
      if (id === sessionId) term.write(data)
    })
    const onInput = term.onData((data) => api.sessions.write(sessionId, data))
    const ro = new ResizeObserver(() => doFit())
    ro.observe(el)
    doFit()

    return () => {
      disposed = true
      ro.disconnect()
      offData()
      onInput.dispose()
      term.dispose()
    }
  }, [sessionId])

  return <div ref={host} className={'terminal' + (alive ? '' : ' terminal-dead')} />
}
