import { useState } from 'react'
import type { Project } from '@shared/types'
import { formatDuration, isOpenRun, runNeedsYou, samePath, toolSummary, type RunAgent, type RunStep, type RunView } from '@shared/runs'
import { api } from '../api'

interface Props {
  runs: RunView[]
  projects: Project[]
  onClose(): void
}

function hex(tint: number): string {
  return '#' + tint.toString(16).padStart(6, '0')
}

/** What a run's status means, in a few words. */
export function statusText(run: RunView): string {
  if (run.status === 'running') return run.alive ? `Running: ${run.currentStep ?? 'starting'}` : 'Its driver stopped'
  if (run.status === 'waiting-you') return 'Needs you'
  if (run.status === 'waiting-human') return 'Your turn'
  if (run.status === 'paused-quota') return 'Paused: usage window'
  if (run.status === 'done') return run.pr ? 'Done: PR open' : 'Done'
  return 'Stopped'
}

const OUTCOME_MARK: Record<RunStep['outcome'], string> = {
  running: '⏳',
  passed: '✔',
  failed: '✖',
  'needs-you': '❗',
  paused: '⏸',
  stopped: '■',
  skipped: '·'
}

/** A cost at API prices. On a subscription nothing is charged; it shows how heavy a step was. */
function cost(usd: number): string {
  return usd > 0 ? `$${usd.toFixed(2)}` : ''
}

/** Every run, the ones that want something first: each step's time, weight, tools and sessions. */
export function RunsPanel({ runs, projects, onClose }: Props) {
  const sorted = [...runs].sort((a, b) => Number(runNeedsYou(b)) - Number(runNeedsYou(a)) || Number(isOpenRun(b)) - Number(isOpenRun(a)) || b.startedAt - a.startedAt)

  return (
    <aside className="waiting-panel runs-panel" aria-label="Runs">
      <header>
        <h2>Runs</h2>
        <span className="hint">Ctrl+Shift+R</span>
        <span className="spacer" />
        <button className="ghost" title="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      {sorted.length === 0 ? (
        <p className="waiting-empty">No runs yet. Patrol starts one for each ready, agent-owned ticket, or run `botalot start implement &lt;ticket&gt;` in a realm.</p>
      ) : (
        <ul>
          {sorted.map((run) => (
            <RunRow key={run.id} run={run} project={projects.find((p) => samePath(p.path, run.mainRepo))} />
          ))}
        </ul>
      )}
    </aside>
  )
}

/** A run's steps as a table: each step's outcome, time, weight, sessions, tools and checks. */
export function RunSteps({ run, onError }: { run: RunView; onError(message: string): void }) {
  return (
    <table className="run-steps">
      <tbody>
        {run.steps.map((step) => (
          <StepRows key={step.id} run={run} step={step} onError={onError} />
        ))}
      </tbody>
    </table>
  )
}

function RunRow({ run, project }: { run: RunView; project?: Project }) {
  const [open, setOpen] = useState(isOpenRun(run))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const canCarryOn = runNeedsYou(run) || run.status === 'paused-quota'
  return (
    <li className={'waiting-row run-row run-' + run.status + (runNeedsYou(run) ? ' run-needs-you' : '')}>
      <div className="waiting-head">
        <button className="ghost small run-toggle" onClick={() => setOpen((o) => !o)} title={open ? 'Hide steps' : 'Show steps'}>
          {open ? '▾' : '▸'}
        </button>
        <span className="dragon-name" style={{ color: hex(project?.tint ?? 0xffffff) }}>
          {project?.name ?? run.repoName} #{run.ticket}
        </span>
        <span className="hint">
          {run.workflow}
          {run.owner ? ` · ${run.owner === 'agent-owned' ? 'agent' : 'you'}` : ''}
        </span>
        <span className="spacer" />
        <span className="waiting-for" title={`Started ${new Date(run.startedAt).toLocaleString()}`}>
          {formatDuration(run.seconds)}
          {run.cost > 0 ? ` · ${cost(run.cost)}` : ''}
        </span>
      </div>
      <div className="run-status">{statusText(run)}</div>
      {isOpenRun(run) && run.waitReason ? <div className="waiting-why">{run.waitReason}</div> : null}
      {run.status === 'stopped' && run.waitReason ? <div className="waiting-why">{run.waitReason}</div> : null}
      {open && isOpenRun(run) && run.waitDetail ? <pre className="run-detail">{run.waitDetail}</pre> : null}
      {open ? <RunSteps run={run} onError={setError} /> : null}
      {error ? <div className="waiting-stuck">{error}</div> : null}
      <div className="waiting-actions">
        {run.pr ? (
          <a className="run-link" href={run.pr} target="_blank" rel="noreferrer">
            Pull request
          </a>
        ) : null}
        <span className="spacer" />
        {isOpenRun(run) ? (
          <button className="small" disabled={busy} onClick={() => void act(() => api.runs.stop(run.id))}>
            Stop
          </button>
        ) : null}
        {canCarryOn ? (
          <button className="primary small" disabled={busy} onClick={() => void act(() => api.runs.carryOn(run.id))} title="Runs `botalot next` for this run">
            Carry on
          </button>
        ) : null}
      </div>
    </li>
  )
}

function StepRows({ run, step, onError }: { run: RunView; step: RunStep; onError(message: string): void }) {
  const tools = toolSummary(step.agents)
  const skills = [...new Set(step.agents.flatMap((a) => a.skills))]

  function openSession(agent: RunAgent) {
    if (!agent.session) return
    api.runs.openSession(run.id, agent.session).catch((err: Error) => onError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }

  return (
    <>
      <tr className={'run-step run-step-' + step.outcome}>
        <td className="run-mark">{OUTCOME_MARK[step.outcome]}</td>
        <td className="run-step-name">
          {step.id}
          {step.rounds > 1 ? <span className="hint"> ×{step.rounds}</span> : null}
        </td>
        <td className="run-num">{step.outcome === 'skipped' ? '' : formatDuration(step.seconds)}</td>
        <td className="run-num">{cost(step.cost)}</td>
        <td className="run-sessions">
          {step.agents.map((agent, i) =>
            agent.session ? (
              <button key={i} className="ghost small" title={`Open ${agent.skill} session ${agent.session} as a dragon`} onClick={() => openSession(agent)}>
                {step.agents.length > 1 ? `${agent.skill} ${i + 1}` : agent.skill}
              </button>
            ) : null
          )}
        </td>
      </tr>
      {tools || skills.length ? (
        <tr className="run-step-more">
          <td />
          <td colSpan={4} className="hint">
            {tools}
            {skills.length ? `${tools ? ' · ' : ''}skills: ${skills.join(', ')}` : ''}
          </td>
        </tr>
      ) : null}
      {step.checks.map((check) => (
        <tr key={check.command} className="run-step-more">
          <td />
          <td colSpan={2} className={'hint' + (check.exit === 0 ? '' : ' run-check-failed')}>
            {check.exit === 0 ? '✔' : '✖'} {check.command}
          </td>
          <td className="run-num hint">{formatDuration(check.seconds)}</td>
          <td />
        </tr>
      ))}
    </>
  )
}
