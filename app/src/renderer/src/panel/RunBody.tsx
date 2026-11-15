import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import { isOpenRun, runNeedsYou, type RunView } from '@shared/runs'
import { api } from '../api'
import { RunSteps, statusText } from './RunsPanel'

const clean = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * The body of a run dragon's panel, where another dragon has its terminal. A run's agent steps are headless,
 * so there is no terminal to show: instead its steps, what it is doing right now, and what it needs from you.
 */
export function RunBody({ session, run }: { session: Session; run: RunView }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const feed = useRef<HTMLDivElement>(null)

  // Keep the newest activity in view as it arrives.
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [run.activity.length])

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const open = isOpenRun(run)
  const yourTurn = run.status === 'waiting-human'
  const canCarryOn = runNeedsYou(run) || run.status === 'paused-quota'
  /** A dragon of your own in the run's folder: where you build on a human-owned ticket, or look around. */
  const summonHere = () =>
    api.sessions.spawn({ projectId: session.projectId, target: session.isWorktree ? { kind: 'existing', path: run.cwd } : { kind: 'main' } })

  return (
    <div className="run-body">
      <div className="run-body-head">
        <span className="run-status">{statusText(run)}</span>
        <span className="spacer" />
        {run.pr ? (
          <a className="run-link" href={run.pr} target="_blank" rel="noreferrer">
            Pull request
          </a>
        ) : null}
      </div>
      {yourTurn ? (
        <p className="run-turn">
          This ticket is yours to build. Summon a dragon here to work with, or build it in your own editor. When the change is ready, <b>Carry on</b> runs the
          checks and reviews on your work.
        </p>
      ) : null}
      {open && run.waitDetail ? <pre className="run-detail">{run.waitDetail}</pre> : null}
      {error ? <div className="error">{error}</div> : null}
      <div className="run-body-actions">
        {open ? (
          <button className="small" disabled={busy} onClick={() => void act(summonHere)} title="Summon a dragon of your own in this run's folder">
            Summon a dragon here
          </button>
        ) : null}
        <span className="spacer" />
        {open ? (
          <button className="danger small" disabled={busy} onClick={() => void act(() => api.runs.stop(run.id))} title="End the run and stop the agent it is running">
            Stop
          </button>
        ) : null}
        {canCarryOn ? (
          <button className="primary small" disabled={busy} onClick={() => void act(() => api.runs.carryOn(run.id))} title="Runs `botalot next` for this run">
            Carry on
          </button>
        ) : null}
      </div>

      <h3>Steps</h3>
      <RunSteps run={run} onError={setError} />
      <p className="hint">Click a step's session to open it as a dragon and read it or take over.</p>

      <h3>Activity</h3>
      <div className="run-feed" ref={feed}>
        {run.activity.length === 0 ? (
          <span className="hint">Nothing yet.</span>
        ) : (
          run.activity.map((a, i) => (
            <div key={i} className="run-feed-line">
              <span className="run-feed-step">{a.step}</span> {a.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
