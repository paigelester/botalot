// Patrol: per realm, pick up issues labelled ready-for-agent and summon a background dragon for each,
// then settle the issue by its label once the dragon opens a pull request or dies.
// Everything outside (trackers, dragons, git hosts) comes in through PatrolDeps, so this file is
// testable with fakes: it imports only shared code, with explicit .ts extensions for Node's test runner.
import type { Issue, PatrolMark, Project, PullRequestInfo, Session, SpawnRequest } from '../shared/types.ts'
import { issueBranch, patrolPrompt } from '../shared/issues.ts'
import { DEFAULT_PATROL_ALLOW } from '../shared/patrol.ts'

/** The label lifecycle of a patrolled issue. The same names on GitHub and Jira. */
export const LABEL = { ready: 'ready-for-agent', working: 'agent-working', done: 'agent-done', human: 'ready-for-human' } as const

/** A dragon may die on an issue this many times before the issue goes to a human. */
export const MAX_ATTEMPTS = 2

/** What patrol needs from a realm's issue tracker. Implemented for GitHub and Jira in patrolTrackers.ts. */
export interface PatrolTracker {
  /** The oldest open issue labelled ready-for-agent, or null when there is none. */
  oldestReady(): Promise<Issue | null>
  /** The issue's current labels, read fresh: the label is the lock between patrols. */
  labels(key: string): Promise<string[]>
  relabel(key: string, remove: string[], add: string[]): Promise<void>
  comment(key: string, text: string): Promise<void>
  /** Create the patrol labels where the tracker needs them created first. Called once per realm per run. */
  ensureLabels(): Promise<void>
}

/** How often a dragon has died on each issue, kept across restarts. Keyed by realm and issue. */
export interface AttemptStore {
  get(key: string): number
  set(key: string, n: number): void
}

export interface PatrolDeps {
  projects(): Project[]
  sessions(): Session[]
  trackerFor(p: Project): PatrolTracker | null
  pullRequest(repo: string, branch: string): Promise<PullRequestInfo | null>
  summon(req: SpawnRequest, p: Project): Promise<Session>
  mark(sessionId: string, mark: PatrolMark): void
  attempts: AttemptStore
  log(message: string): void
}

export class Patrol {
  private running = false
  private labelled = new Set<string>()
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

    // First settle what earlier rounds started: a pull request means done, a fallen dragon means retry or a human.
    for (const s of this.deps.sessions()) {
      if (s.projectId !== p.id || !s.patrol || s.patrol.settled) continue
      const pr = s.branch ? await this.deps.pullRequest(p.path, s.branch) : null
      if (pr) {
        await tracker.relabel(s.patrol.issueKey, [LABEL.working], [LABEL.done])
        await tracker.comment(s.patrol.issueKey, `Botalot patrol: ${s.name} opened ${pr.url}`)
        this.deps.mark(s.id, { ...s.patrol, settled: 'done' })
      } else if (s.state === 'dead') {
        const settled = await this.giveBack(p, tracker, s.patrol.issueKey, `${s.name} fell before opening a pull request${s.attention ? ` (${s.attention})` : ''}.`)
        this.deps.mark(s.id, { ...s.patrol, settled })
      }
    }

    const alive = this.deps.sessions().filter((s) => s.projectId === p.id && s.patrol && !s.patrol.settled && s.state !== 'dead').length
    if (alive >= Math.max(1, p.patrol?.max ?? 1)) return

    const issue = await tracker.oldestReady()
    if (!issue) return
    // Re-read the labels just before taking it: another Botalot may have got there first.
    const labels = await tracker.labels(issue.key)
    if (!labels.includes(LABEL.ready) || labels.includes(LABEL.working)) return
    await tracker.relabel(issue.key, [LABEL.ready], [LABEL.working])

    const kind = p.tracker?.kind ?? 'none'
    let dragon: Session
    try {
      dragon = await this.deps.summon(
        { projectId: p.id, agent: 'claude', target: { kind: 'new', branch: issueBranch(issue) }, prompt: patrolPrompt(issue, kind), background: true, allow: p.patrol?.allow ?? DEFAULT_PATROL_ALLOW },
        p
      )
    } catch (err) {
      await this.giveBack(p, tracker, issue.key, `Botalot could not summon a dragon: ${(err as Error).message}`)
      return
    }
    this.deps.mark(dragon.id, { issueKey: issue.key, issueUrl: issue.url })
    this.deps.log(`patrol ${p.name}: ${dragon.name} took ${issue.key}`)
  }

  /** An attempt failed: hand the issue back to patrol, or to a human once it has failed MAX_ATTEMPTS times. */
  private async giveBack(p: Project, tracker: PatrolTracker, key: string, why: string): Promise<'retried' | 'human'> {
    const id = `${p.id}:${key}`
    const n = this.deps.attempts.get(id) + 1
    this.deps.attempts.set(id, n)
    if (n >= MAX_ATTEMPTS) {
      await tracker.relabel(key, [LABEL.working], [LABEL.human])
      await tracker.comment(key, `Botalot patrol: ${why} That was attempt ${n}, so this goes to a human (${LABEL.human}).`)
      return 'human'
    }
    await tracker.relabel(key, [LABEL.working], [LABEL.ready])
    await tracker.comment(key, `Botalot patrol: ${why} Putting it back as ${LABEL.ready} for one more try.`)
    return 'retried'
  }
}
