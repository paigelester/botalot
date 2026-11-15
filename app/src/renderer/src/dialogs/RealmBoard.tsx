import { useEffect, useState } from 'react'
import type { Issue, Project } from '@shared/types'
import type { Board, BoardTicket, RoutedTicket } from '@shared/board'
import { api } from '../api'

interface Props {
  project: Project
  /** Undefined when the realm has no board: no GitHub tracker, or no contract yet. */
  board: Board | undefined
  onClose(): void
  /** Open the Summon dialog for this realm. */
  onSummon(): void
}

const clean = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The issue a run is started for, from what the board knows of the ticket. */
const asIssue = (t: BoardTicket): Issue => ({ key: String(t.number), title: t.title, body: '', labels: [], assignees: [], updatedAt: '', url: t.url })

/**
 * A realm's board: the tickets waiting on you, grouped by what they need. Planning runs (the goblin) put
 * their results here rather than standing on the map: a routed ticket waits to be approved.
 */
export function RealmBoard({ project, board, onClose, onSummon }: Props) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [patrol, setPatrol] = useState(!!project.patrol?.enabled)

  async function setPatrolOn(enabled: boolean) {
    setPatrol(enabled)
    try {
      await api.projects.update(project.id, { patrol: { max: 1, ...project.patrol, enabled } })
    } catch (err) {
      setPatrol(!enabled)
      setError(clean(err))
    }
  }

  useEffect(() => {
    void api.board.refresh(project.id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [project.id, onClose])

  async function act(ticket: number, action: () => Promise<unknown>) {
    setBusy(ticket)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(null)
    }
  }

  const empty = board && board.toApprove.length + board.needsYou.length + board.yoursToBuild.length + board.inReview.length === 0

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide board" onMouseDown={(e) => e.stopPropagation()}>
        <div className="board-head">
          <h2>{project.name}: the board</h2>
          <span className="spacer" />
          {board ? (
            <label className="board-patrol" title="Patrol starts this realm's due runs on its own while Botalot is open: routing for selected tickets, building for ready, agent-owned ones.">
              <input type="checkbox" checked={patrol} onChange={(e) => void setPatrolOn(e.target.checked)} />
              Patrol {patrol ? 'on' : 'off'}
            </label>
          ) : null}
          <button className="primary" onClick={onSummon}>
            Summon a dragon
          </button>
        </div>
        {!board ? (
          <p className="hint">This realm has no board yet. It needs GitHub as its tracker and a contract: press Set up beside it in Realms.</p>
        ) : empty ? (
          <p className="waiting-empty">Nothing is waiting on you here.</p>
        ) : (
          <>
            <Group title="To approve" hint="Routed by the goblin. Approving makes the ticket ready to build." items={board.toApprove}>
              {(t) => <Routed key={t.number} ticket={t} busy={busy === t.number} onApprove={() => void act(t.number, () => api.board.approve(project.id, t.number))} />}
            </Group>
            <Group title="Needs you" hint="A run asked a question or got blocked. The reason is on the ticket." items={board.needsYou}>
              {(t) => <Row key={t.number} ticket={t} />}
            </Group>
            <Group title="Yours to build" hint="Ready and human-owned. Starting the run claims the ticket and makes its holding; you build, then it checks and reviews your work." items={board.yoursToBuild}>
              {(t) => (
                <Row key={t.number} ticket={t}>
                  <button className="primary small" disabled={busy === t.number} onClick={() => void act(t.number, () => api.runs.start(project.id, asIssue(t)))}>
                    {busy === t.number ? 'Starting…' : 'Start run'}
                  </button>
                </Row>
              )}
            </Group>
            <Group title="In review" hint="A pull request is open." items={board.inReview}>
              {(t) => <Row key={t.number} ticket={t} />}
            </Group>
          </>
        )}
        {error ? <div className="error">{error}</div> : null}
        <div className="actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function Group<T extends BoardTicket>({ title, hint, items, children }: { title: string; hint: string; items: T[]; children(item: T): React.ReactNode }) {
  if (items.length === 0) return null
  return (
    <section className="board-group">
      <h3>
        {title} <span className="hint">({items.length})</span>
      </h3>
      <p className="hint">{hint}</p>
      {items.map(children)}
    </section>
  )
}

function Row({ ticket, children }: { ticket: BoardTicket; children?: React.ReactNode }) {
  return (
    <div className="board-row">
      <a href={ticket.url} target="_blank" rel="noreferrer" title="Open the ticket on GitHub">
        #{ticket.number}
      </a>
      <span className="board-title">{ticket.title}</span>
      <span className="spacer" />
      {children}
    </div>
  )
}

function Routed({ ticket, busy, onApprove }: { ticket: RoutedTicket; busy: boolean; onApprove(): void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="board-routed">
      <Row ticket={ticket}>
        <span className={'badge board-owner-' + ticket.owner}>{ticket.owner === 'agent-owned' ? 'agent builds it' : 'you build it'}</span>
        {ticket.plan ? (
          <button className="ghost small" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide plan' : 'Plan'}
          </button>
        ) : null}
        <button className="primary small" disabled={busy} onClick={onApprove} title="Runs `botalot approve`: the ticket moves from selected to ready">
          {busy ? 'Approving…' : 'Approve'}
        </button>
      </Row>
      {open && ticket.plan ? <pre className="board-plan">{ticket.plan}</pre> : null}
    </div>
  )
}
