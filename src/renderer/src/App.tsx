import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, Session } from '@shared/types'
import { api } from './api'
import { Kingdom } from './scene/Kingdom'
import { SessionPanel } from './panel/SessionPanel'
import { SummonDialog } from './dialogs/SummonDialog'
import { RealmsDialog } from './dialogs/RealmsDialog'

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [wide, setWide] = useState(false)
  const [summon, setSummon] = useState<{ projectId: string | null } | null>(null)
  const [realms, setRealms] = useState(false)

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
    return () => {
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
      } else if (e.key === 'Escape' && !summon && !realms) {
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [summon, realms])

  const sessionList = useMemo(() => [...sessions.values()], [sessions])
  const selected = selectedId ? sessions.get(selectedId) : undefined
  const waiting = sessionList.filter((s) => s.state === 'waiting').length
  const working = sessionList.filter((s) => s.state === 'working').length
  const dormant = sessionList.filter((s) => s.state === 'dormant').length

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Botalot` : 'Botalot'
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
          <span className={'pill pill-waiting' + (waiting > 0 ? ' pill-alert' : '')}>{waiting} awaiting you</span>
          <span className="pill">
            {sessionList.length} dragons{dormant ? ', ' + dormant + ' dormant' : ''}
          </span>
        </div>
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
        <span>❗ gold ring = awaiting your word</span>
        <span>💤 curled = resting</span>
        <span>🪦 grey = fallen</span>
        <span>🌙 faded = dormant, click to wake</span>
        <span>🌿 green name = wild</span>
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
