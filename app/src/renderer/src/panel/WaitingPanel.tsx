import { useEffect, useState } from 'react'
import { UNCLAIMED_REALM, type Project, type Session } from '@shared/types'
import type { Board } from '@shared/board'
import { api } from '../api'

interface Props {
  sessions: Session[]
  projects: Project[]
  /** Every realm's board: its tickets to approve are listed above the dragons. */
  boards: Record<string, Board>
  onOpenBoard(projectId: string): void
  onOpen(id: string): void
  onClose(): void
}

function hex(tint: number): string {
  return '#' + tint.toString(16).padStart(6, '0')
}

function waited(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Every dragon awaiting your word, longest-waiting first, each with a quick reply. */
export function WaitingPanel({ sessions, projects, boards, onOpen, onOpenBoard, onClose }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  // Stuck dragons first (working ones included: they need a look too), then longest-waiting first.
  const toApprove = projects.flatMap((p) => (boards[p.id]?.toApprove ?? []).map((t) => ({ project: p, ticket: t })))
  const waiting = sessions
    .filter((s) => s.state === 'waiting' || !!s.stuck)
    .sort((a, b) => Number(!!b.stuck) - Number(!!a.stuck) || a.stateSince - b.stateSince)

  return (
    <aside className="waiting-panel" aria-label="Awaiting you">
      <header>
        <h2>Awaiting your word</h2>
        <span className="hint">Ctrl+Shift+A</span>
        <span className="spacer" />
        <button className="ghost" title="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {waiting.length === 0 && toApprove.length === 0 ? (
        <p className="waiting-empty">No dragon awaits you. The kingdom is at peace.</p>
      ) : (
        <ul>
          {toApprove.map(({ project, ticket }) => (
            <li key={project.id + ticket.number} className="waiting-row">
              <div className="waiting-head">
                <span className="dragon-name" style={{ color: hex(project.tint) }}>
                  #{ticket.number} {ticket.title}
                </span>
                <span className="spacer" />
              </div>
              <div className="waiting-why">Routed: {ticket.owner === 'agent-owned' ? 'an agent builds it' : 'you build it'}. Waiting for your approval.</div>
              <div className="waiting-actions">
                <span className="hint">🏰 {project.name}</span>
                <span className="spacer" />
                <button className="primary small" onClick={() => onOpenBoard(project.id)}>
                  Open board
                </button>
              </div>
            </li>
          ))}
          {waiting.map((s) => {
            const project = projects.find((p) => p.id === s.projectId)
            const realm = project?.name ?? (s.projectId === UNCLAIMED_REALM ? 'Unclaimed lands' : 'Unknown realm')
            return <WaitingRow key={s.id} session={s} realm={realm} tint={project?.tint ?? 0xffffff} waited={waited(s.stateSince, now)} onOpen={onOpen} />
          })}
        </ul>
      )}
    </aside>
  )
}

interface RowProps {
  session: Session
  realm: string
  tint: number
  waited: string
  onOpen(id: string): void
}

function WaitingRow({ session, realm, tint, waited, onOpen }: RowProps) {
  const [reply, setReply] = useState('')
  // A background dragon has no terminal of the app's own to type into; its reply goes through attaching.
  // A run has none either: it is answered on its ticket or by doing your step, then carried on from its panel.
  const canReply = !session.backgroundId && !session.run

  function send() {
    const text = reply.trim()
    if (!text) return
    api.sessions.write(session.id, text)
    // Enter separately: sent in one write, the agent's input box reads it as a pasted newline, not a submit.
    setTimeout(() => api.sessions.write(session.id, '\r'), 60)
    setReply('')
  }

  return (
    <li className="waiting-row">
      <div className="waiting-head">
        <span className="dragon-name" style={{ color: hex(tint) }}>
          {session.name}
        </span>
        <span className="hint">🏰 {realm}</span>
        <span className="spacer" />
        <span className="waiting-for" title={new Date(session.stateSince).toLocaleTimeString()}>
          {waited}
        </span>
      </div>
      {session.stuck ? <div className="waiting-stuck">Looks stuck: {session.stuck}</div> : null}
      <div className="waiting-why">{session.attention || (session.state === 'waiting' ? 'Waiting for you' : 'Working')}</div>
      <div className="waiting-actions">
        {canReply ? (
          <input
            type="text"
            placeholder="Quick reply, Enter to send"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                send()
              }
            }}
          />
        ) : (
          <span className="hint">{session.run ? 'Run: open it to see what it needs and carry it on' : 'Background session: open it to reply'}</span>
        )}
        {canReply ? (
          <button className="small" onClick={send} disabled={!reply.trim()}>
            Send
          </button>
        ) : null}
        <button className="primary small" onClick={() => onOpen(session.id)}>
          Open
        </button>
      </div>
    </li>
  )
}
