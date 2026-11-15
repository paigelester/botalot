/**
 * Factory runs, as the `factory` driver (paigelester/skills) writes them to its runs folder: a state file
 * (`<id>.json`) and a run log (`<id>.jsonl`, one JSON event per line). This turns the two into what the Runs
 * panel shows. Pure, so it is testable: imports nothing.
 */

/** Where a run rests. Only `running` has a live driver process. */
export type RunStatus = 'running' | 'waiting-human' | 'waiting-you' | 'paused-quota' | 'done' | 'stopped'

/** One fresh agent session a step ran, with what it used. */
export interface RunAgent {
  skill: string
  /** The Claude Code session id: `claude --resume <session>` reopens it. */
  session: string | null
  seconds: number
  /** What the step would have cost at API prices, in US dollars. A measure of weight on a subscription. */
  cost: number | null
  tokens: { input: number; output: number } | null
  model: string | null
  /** Tool name to how many times it was called. */
  tools: Record<string, number>
  /** Skills the agent invoked itself, beyond the step skill it was given. */
  skills: string[]
  ok: boolean
}

export interface RunCheck {
  command: string
  exit: number
  seconds: number
}

export type StepOutcome = 'running' | 'passed' | 'failed' | 'needs-you' | 'paused' | 'stopped' | 'skipped'

/** One step of the workflow, with every round of it folded together. */
export interface RunStep {
  id: string
  /** How the latest round ended; `running` while it is under way. */
  outcome: StepOutcome
  /** How many times the step ran: more than 1 means a gate sent the run back. */
  rounds: number
  seconds: number
  cost: number
  agents: RunAgent[]
  /** The checks of the latest round. */
  checks: RunCheck[]
}

export interface RunView {
  id: string
  /** The repo's main checkout, forward-slashed: matches a realm's path. */
  mainRepo: string
  /** Where the run works: the main checkout or one of its holdings. */
  cwd: string
  repoName: string
  ticket: number
  workflow: string
  owner: 'agent-owned' | 'human-owned' | null
  status: RunStatus
  /** False when the run says `running` but its driver process is gone: it needs carrying on. */
  alive: boolean
  branch: string | null
  pr: string | null
  /** Why the run is resting, when it is. */
  waitReason: string | null
  waitDetail: string | null
  /** The step the run is at or resting on. */
  currentStep: string | null
  startedAt: number
  updatedAt: number
  seconds: number
  cost: number
  steps: RunStep[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

const STATUSES: RunStatus[] = ['running', 'waiting-human', 'waiting-you', 'paused-quota', 'done', 'stopped']

/** Parse a run log's text. Lines that aren't JSON objects (a half-written last line, say) are dropped. */
export function parseRunLog(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e: unknown = JSON.parse(line)
      if (e && typeof e === 'object') events.push(e as Record<string, unknown>)
    } catch {
      /* a line still being written */
    }
  }
  return events
}

/**
 * Build the view of one run from its state file and its log. Returns null when the state isn't a run
 * (some other JSON file in the folder). `alive` is whether the state's process is running, which only
 * the caller can check.
 */
export function buildRunView(stateJson: unknown, events: Record<string, unknown>[], alive: boolean): RunView | null {
  const s = obj(stateJson)
  const id = str(s.id)
  const status = STATUSES.find((x) => x === s.status)
  if (!id || !status || typeof s.ticket !== 'number') return null

  const steps: RunStep[] = []
  const stepOf = (stepId: string): RunStep => {
    let step = steps.find((x) => x.id === stepId)
    if (!step) {
      step = { id: stepId, outcome: 'running', rounds: 0, seconds: 0, cost: 0, agents: [], checks: [] }
      steps.push(step)
    }
    return step
  }
  for (const e of events) {
    const stepId = str(e.step)
    if (!stepId) continue
    if (e.event === 'step-start') {
      const step = stepOf(stepId)
      step.rounds++
      step.outcome = 'running'
      step.checks = []
    } else if (e.event === 'step-end') {
      const step = stepOf(stepId)
      step.outcome = (str(e.outcome) as StepOutcome | null) ?? 'failed'
      step.seconds += num(e.seconds)
    } else if (e.event === 'step-skip') {
      stepOf(stepId).outcome = 'skipped'
    } else if (e.event === 'agent') {
      const step = stepOf(stepId)
      const tokens = obj(e.tokens)
      const agent: RunAgent = {
        skill: str(e.skill) ?? stepId,
        session: str(e.session),
        seconds: num(e.seconds),
        cost: typeof e.cost === 'number' ? e.cost : null,
        tokens: e.tokens ? { input: num(tokens.input), output: num(tokens.output) } : null,
        model: str(e.model),
        tools: Object.fromEntries(Object.entries(obj(e.tools)).filter((kv): kv is [string, number] => typeof kv[1] === 'number')),
        skills: Array.isArray(e.skills) ? e.skills.filter((x): x is string => typeof x === 'string') : [],
        ok: e.ok === true
      }
      step.agents.push(agent)
      step.cost += agent.cost ?? 0
    } else if (e.event === 'check') {
      stepOf(stepId).checks.push({ command: str(e.command) ?? '', exit: num(e.exit), seconds: num(e.seconds) })
    }
  }
  // A step left `running` in the log of a run that isn't running was cut short.
  if (status !== 'running' || !alive) for (const step of steps) if (step.outcome === 'running') step.outcome = 'stopped'

  const wait = obj(s.wait)
  const owner = s.owner === 'agent-owned' || s.owner === 'human-owned' ? s.owner : null
  const startedAt = Date.parse(str(s.startedAt) ?? '') || 0
  return {
    id,
    mainRepo: (str(s.mainRepo) ?? str(s.repo) ?? '').split('\\').join('/'),
    cwd: str(s.repo) ?? '',
    repoName: str(s.repoName) ?? '',
    ticket: s.ticket,
    workflow: str(s.workflow) ?? '',
    owner,
    status,
    alive,
    branch: str(s.branch),
    pr: str(s.pr),
    waitReason: str(wait.reason) ?? str(s.stopped),
    waitDetail: str(wait.detail),
    currentStep: str(wait.step) ?? steps.find((x) => x.outcome === 'running')?.id ?? null,
    startedAt,
    updatedAt: Date.parse(str(s.updatedAt) ?? '') || startedAt,
    seconds: num(s.activeSeconds),
    cost: steps.reduce((sum, step) => sum + step.cost, 0),
    steps
  }
}

/** Whether two paths name the same folder, whatever their slashes, case or trailing slash. */
export function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Whether a run still wants something: it is going, or resting until someone carries it on. */
export function isOpenRun(run: Pick<RunView, 'status'>): boolean {
  return run.status !== 'done' && run.status !== 'stopped'
}

/** Whether a run needs the human: an answer, their own step, or a carry-on after its driver died. */
export function runNeedsYou(run: Pick<RunView, 'status' | 'alive'>): boolean {
  return run.status === 'waiting-you' || run.status === 'waiting-human' || (run.status === 'running' && !run.alive)
}

/** Seconds as "42s", "3m 05s" or "1h 12m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A step's tool use at a glance, most used first: "Edit 14 · Bash 6". */
export function toolSummary(agents: RunAgent[]): string {
  const total = new Map<string, number>()
  for (const a of agents) for (const [name, n] of Object.entries(a.tools)) total.set(name, (total.get(name) ?? 0) + n)
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
}
