// Patrol: per realm, pick up tickets labelled factory:ready + factory:agent-owned and start a factory run of the
// implement workflow for each. The run's driver (the `factory` command) does the work and moves the ticket's
// labels itself; patrol only chooses what to start, and tells a human when a run could not start or fell over.
// Everything outside (trackers, runs, the driver) comes in through PatrolDeps, so this file is
// testable with fakes: it imports only shared code, with explicit .ts extensions for Node's test runner.
import type { Issue, Project } from '../shared/types.ts'
import { isOpenRun, samePath, type RunView } from '../shared/runs.ts'

/**
 * The factory labels patrol reads and writes (the factory-labels skill defines them all). A ticket is patrol's
 * when it carries both `ready` and `agent`. The driver moves it on from `ready` when a run claims it.
 */
export const LABEL = {
  ready: 'factory:ready',
  agent: 'factory:agent-owned',
  needsYou: 'factory:needs-you'
} as const

/** A run may fail to start for a ticket this many times before patrol hands the ticket to a human. */
export const MAX_ATTEMPTS = 2

/** What patrol needs from a realm's issue tracker. Implemented for GitHub in patrolTrackers.ts. */
export interface PatrolTracker {
  /** Open issues labelled both factory:ready and factory:agent-owned, oldest first. */
  ready(): Promise<Issue[]>
  relabel(key: string, remove: string[], add: string[]): Promise<void>
  comment(key: string, text: string): Promise<void>
  /** Create the labels patrol writes where the tracker needs them created first. Called once per realm per app run. */
  ensureLabels(): Promise<void>
}

/** What patrol remembers across restarts. */
export interface PatrolMemory {
  /** How often a run has failed to start for a ticket. Keyed by realm and issue. */
  attempts(key: string): number
  setAttempts(key: string, n: number): void
  /** Whether patrol has already told a human about a run that fell over. */
  settled(runId: string): boolean
  settle(runId: string): void
}

export interface PatrolDeps {
  projects(): Project[]
  /** Every factory run the driver knows of, any realm. */
  runs(): RunView[]
  trackerFor(p: Project): PatrolTracker | null
  /**
   * Make the ticket's holding and start a run there. Resolves once the driver has taken the run as far as it
   * can (done, or resting on a human); rejects with the reason when no run could be started at all.
   */
  start(p: Project, issue: Issue): Promise<void>
  memory: PatrolMemory
  log(message: string): void
}

export class Patrol {
  private running = false
  private labelled = new Set<string>()
  /** Tickets whose driver patrol has started and not yet seen exit, as `realm:issue`. */
  private starting = new Set<string>()
  private deps: PatrolDeps

  constructor(deps: PatrolDeps) {
    this.deps = deps
  }

  /** One round over every realm with patrol on. Never overlaps itself; errors stay within their realm. */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const p of this.deps.projects()) {
        if (!p.patrol?.enabled) continue
        try {
          await this.patrolRealm(p)
        } catch (err) {
          this.deps.log(`patrol ${p.name}: ${(err as Error).message}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async patrolRealm(p: Project): Promise<void> {
    const tracker = this.deps.trackerFor(p)
    if (!tracker) return
    if (!this.labelled.has(p.id)) {
      await tracker.ensureLabels()
      this.labelled.add(p.id)
    }
    const runs = this.deps.runs().filter((r) => samePath(r.mainRepo, p.path) && r.owner !== 'human-owned')

    // A run that stopped on a problem, or whose driver died, sits there until someone looks. Say so on its ticket, once.
    for (const run of runs) {
      const fell = run.status === 'stopped' || (run.status === 'running' && !run.alive)
      if (!fell || this.deps.memory.settled(run.id) || this.starting.has(`${p.id}:${run.ticket}`)) continue
      this.deps.memory.settle(run.id)
      const why = run.status === 'stopped' ? `stopped${run.waitReason ? `: ${run.waitReason}` : ''}` : `lost its driver at the "${run.currentStep ?? 'first'}" step`
      // It loses factory:ready too (a run that stopped before claiming still has it), or patrol would start it again.
      await tracker.relabel(String(run.ticket), [LABEL.ready], [LABEL.needsYou])
      await tracker.comment(String(run.ticket), `Botalot patrol: factory run \`${run.id}\` ${why}. Carry it on from Botalot's Runs panel, or with \`factory next ${run.id}\`.`)
      this.deps.log(`patrol ${p.name}: run ${run.id} fell; flagged #${run.ticket}`)
    }

    // Runs that are going count against the realm's limit; runs resting on a human don't hold a place.
    const going = new Set(runs.filter((r) => r.status === 'running' && r.alive).map((r) => `${p.id}:${r.ticket}`))
    for (const key of this.starting) if (key.startsWith(`${p.id}:`)) going.add(key)
    let room = Math.max(1, p.patrol?.max ?? 1) - going.size
    if (room <= 0) return

    // A ticket with an open run is never started twice: its run is the place to carry on from.
    const taken = new Set(runs.filter(isOpenRun).map((r) => String(r.ticket)))
    for (const issue of await tracker.ready()) {
      if (room <= 0) break
      const key = `${p.id}:${issue.key}`
      if (taken.has(issue.key) || this.starting.has(key)) continue
      room--
      this.starting.add(key)
      this.deps.log(`patrol ${p.name}: starting a run for #${issue.key}`)
      void this.deps
        .start(p, issue)
        .then(
          () => this.deps.memory.setAttempts(key, 0),
          (err: Error) => this.couldNotStart(p, tracker, issue, err.message)
        )
        .catch((err: Error) => this.deps.log(`patrol ${p.name}: ${err.message}`))
        .finally(() => this.starting.delete(key))
    }
  }

  /**
   * No run could be started for a ticket (the realm's contract doesn't pass, the driver is missing, the holding
   * could not be made). The ticket stays ready for another try, or after MAX_ATTEMPTS is handed to a human:
   * it loses factory:ready, so patrol leaves it alone until a person fixes the cause and labels it ready again.
   */
  private async couldNotStart(p: Project, tracker: PatrolTracker, issue: Issue, why: string): Promise<void> {
    const key = `${p.id}:${issue.key}`
    const n = this.deps.memory.attempts(key) + 1
    this.deps.memory.setAttempts(key, n)
    this.deps.log(`patrol ${p.name}: could not start a run for #${issue.key} (attempt ${n}): ${why.split('\n')[0]}`)
    if (n < MAX_ATTEMPTS) return
    this.deps.memory.setAttempts(key, 0)
    await tracker.relabel(issue.key, [LABEL.ready], [LABEL.needsYou])
    await tracker.comment(issue.key, `Botalot patrol could not start a factory run for this ticket (${n} attempts):\n\n${why}\n\nFix the cause, then label it ${LABEL.ready} again.`)
  }
}
