import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, Session } from '@shared/types'
import { isOpenRun, runNeedsYou, type RunView } from '@shared/runs'
import { api } from './api'
import { Kingdom } from './scene/Kingdom'
import { SessionPanel } from './panel/SessionPanel'
import { WaitingPanel } from './panel/WaitingPanel'
import { RunsPanel } from './panel/RunsPanel'
import { SummonDialog } from './dialogs/SummonDialog'
import { RealmsDialog } from './dialogs/RealmsDialog'
import { QuotaGauge } from './QuotaGauge'

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [wide, setWide] = useState(false)
  const [summon, setSummon] = useState<{ projectId: string | null } | null>(null)
  const [realms, setRealms] = useState(false)
  const [waitingOpen, setWaitingOpen] = useState(false)
  const [runs, setRuns] = useState<RunView[]>([])
  const [runsOpen, setRunsOpen] = useState(false)

  useEffect(() => {
    void api.projects.list().then(setProjects)
    void api.sessions.list().then((list) => setSessions(new Map(list.map((s) => [s.id, s]))))
    const offP = api.projects.onChanged(setProjects)
    const offU = api.sessions.onUpdate((s) =>
      setSessions((prev) => {
        const next = new Map(prev)
        next.set(s.id, s)
        return next
      })
    )
    const offR = api.sessions.onRemoved((id) =>
      setSessions((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    )
    const offF = api.sessions.onFocus((id) => setSelectedId(id))
    void api.runs.list().then(setRuns)
    const offRuns = api.runs.onUpdate(setRuns)
    return () => {
      offRuns()
      offP()
      offU()
      offR()
      offF()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '\\') {
        e.preventDefault()
        setWide((w) => !w)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setWaitingOpen((o) => !o)
        setRunsOpen(false)
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        setRunsOpen((o) => !o)
        setWaitingOpen(false)
      } else if (e.key === 'Escape' && !summon && !realms) {
        if (waitingOpen) setWaitingOpen(false)
        else if (runsOpen) setRunsOpen(false)
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [summon, realms, waitingOpen, runsOpen])

  const sessionList = useMemo(() => [...sessions.values()], [sessions])
  const selected = selectedId ? sessions.get(selectedId) : undefined
  // Stuck dragons need you too, even while they still count as working.
  const waiting = sessionList.filter((s) => s.state === 'waiting' || !!s.stuck).length
  const working = sessionList.filter((s) => s.state === 'working').length
  const dormant = sessionList.filter((s) => s.state === 'dormant').length
  const openRuns = runs.filter(isOpenRun)
  const runsNeedYou = openRuns.filter(runNeedsYou).length

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Botalot` : 'Botalot'
    api.app.setBadge(waiting, waiting > 0 ? drawBadge(waiting) : null)
  }, [waiting])

  const onTapCastle = useCallback((projectId: string) => setSummon({ projectId }), [])

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span className="crest">🐉</span> Botalot
        </h1>
        <div className="counts">
          <span className="pill pill-working">{working} questing</span>
          <button
            className={'pill pill-waiting' + (waiting > 0 ? ' pill-alert' : '') + (waitingOpen ? ' pill-open' : '')}
            onClick={() => {
              setWaitingOpen((o) => !o)
              setRunsOpen(false)
            }}
            title="Show who awaits you (Ctrl+Shift+A)"
          >
            {waiting} awaiting you
          </button>
          <span className="pill">
            {sessionList.length} dragons{dormant ? ', ' + dormant + ' dormant' : ''}
          </span>
          <button
            className={'pill pill-runs' + (runsNeedYou > 0 ? ' pill-alert' : '') + (runsOpen ? ' pill-open' : '')}
            onClick={() => {
              setRunsOpen((o) => !o)
              setWaitingOpen(false)
            }}
            title="Show runs (Ctrl+Shift+R)"
          >
            {openRuns.length} run{openRuns.length === 1 ? '' : 's'}
            {runsNeedYou > 0 ? ', ' + runsNeedYou + ' need you' : ''}
          </button>
        </div>
        <QuotaGauge />
        <span className="spacer" />
        <button className="ghost" onClick={() => setRealms(true)}>
          Realms
        </button>
        <button className="primary" onClick={() => setSummon({ projectId: null })} disabled={projects.length === 0}>
          Summon dragon
        </button>
      </header>

      <main className={'body' + (selected ? ' with-panel' : '') + (wide ? ' wide' : '')}>
        <Kingdom projects={projects} sessions={sessionList} selectedId={selectedId} onSelectDragon={setSelectedId} onTapCastle={onTapCastle} />
        {projects.length === 0 ? (
          <div className="empty">
            <h2>The kingdom is empty</h2>
            <p>No realms found in Claude Code's history. Add a project folder to raise your first castle.</p>
            <button className="primary" onClick={() => setRealms(true)}>
              Open realms
            </button>
          </div>
        ) : null}
        {waitingOpen ? (
          <WaitingPanel sessions={sessionList} projects={projects} onOpen={(id) => setSelectedId(id)} onClose={() => setWaitingOpen(false)} />
        ) : null}
        {runsOpen ? <RunsPanel runs={runs} projects={projects} onClose={() => setRunsOpen(false)} /> : null}
        {selected ? (
          <SessionPanel
            session={selected}
            project={projects.find((p) => p.id === selected.projectId)}
            wide={wide}
            onClose={() => setSelectedId(null)}
            onToggleWide={() => setWide((w) => !w)}
          />
        ) : null}
      </main>

      <footer className="legend">
        <span>🔥 flying = questing</span>
        <span>❗ gold ring = awaits you</span>
        <span>💤 curled = resting</span>
        <span>🪦 grey = fallen</span>
        <span>🌙 faded = dormant</span>
        <span>⭕ red ring = stuck</span>
        <span>🌿 green name = wild</span>
        <span>⚑ = a run</span>
        <span className="spacer" />
        <span>Click a castle to summon there · click a dragon to open its terminal · Esc closes · Ctrl+\ widens</span>
      </footer>

      {summon ? (
        <SummonDialog
          projects={projects}
          initialProjectId={summon.projectId}
          onClose={() => setSummon(null)}
          onSummoned={() => setSummon(null)}
        />
      ) : null}
      {realms ? (
        <RealmsDialog
          onClose={() => {
            setRealms(false)
            void api.projects.list().then(setProjects)
          }}
        />
      ) : null}
    </div>
  )
}

/** The taskbar overlay badge: a gold disc with the waiting count, as a PNG data URL. */
function drawBadge(count: number): string | null {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffd26a'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = '#2a1a00'
  ctx.stroke()
  ctx.fillStyle = '#2a1a00'
  ctx.font = `bold ${count > 9 ? 16 : 20}px "Segoe UI", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 99 ? '99+' : String(count), size / 2, size / 2 + 1)
  return canvas.toDataURL('image/png')
}
