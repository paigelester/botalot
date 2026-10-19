import type { Project, PullRequestInfo, Session } from '@shared/types'
import { pullRequestFor } from './github'

const REFRESH_MS = 60_000

interface Branch {
  repo: string
  branch: string
}

/**
 * Keeps each holding's pull request current: which PR its branch has, and how its checks are going.
 * Looks every minute, and at once when a dragon on that branch goes idle (it may just have pushed).
 */
export class PrWatcher {
  private cache = new Map<string, PullRequestInfo | null>()
  private queue = new Set<string>()
  private running = false
  private timer: NodeJS.Timeout | null = null
  private lastState = new Map<string, Session['state']>()

  constructor(
    private listSessions: () => Session[],
    private getProject: (id: string) => Project | undefined,
    private setPr: (sessionId: string, pr: PullRequestInfo | undefined) => void
  ) {}

  start(): void {
    this.timer = setInterval(() => this.refreshAll(), REFRESH_MS)
    this.refreshAll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Call with every session update. */
  observe(s: Session): void {
    if (!this.timer) return // not started (demo mode)
    const before = this.lastState.get(s.id)
    this.lastState.set(s.id, s.state)
    const b = this.branchOf(s)
    if (!b) return
    const k = key(b)
    if (!this.cache.has(k) || (s.state === 'idle' && before !== 'idle')) this.enqueue(k)
    else if (!sameJson(this.cache.get(k) ?? undefined, s.pr)) this.setPr(s.id, this.cache.get(k) ?? undefined)
  }

  forget(id: string): void {
    this.lastState.delete(id)
  }

  /** Holdings only: the castle's own branch is the default branch, which has no PR of its own. */
  private branchOf(s: Session): Branch | null {
    if (!s.isWorktree || !s.branch) return null
    const project = this.getProject(s.projectId)
    if (!project || project.tracker?.kind !== 'github') return null
    return { repo: project.path, branch: s.branch }
  }

  private refreshAll(): void {
    for (const s of this.listSessions()) {
      const b = this.branchOf(s)
      if (b) this.enqueue(key(b))
    }
  }

  private enqueue(k: string): void {
    this.queue.add(k)
    void this.drain()
  }

  /** One gh call at a time, so a kingdom of holdings never fans out into a burst of processes. */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.size > 0) {
        const k = this.queue.values().next().value as string
        this.queue.delete(k)
        const { repo, branch } = JSON.parse(k) as Branch
        const pr = await pullRequestFor(repo, branch)
        this.cache.set(k, pr)
        for (const s of this.listSessions()) {
          const b = this.branchOf(s)
          if (b && key(b) === k && !sameJson(s.pr, pr ?? undefined)) this.setPr(s.id, pr ?? undefined)
        }
      }
    } finally {
      this.running = false
    }
  }
}

function key(b: Branch): string {
  return JSON.stringify({ repo: b.repo, branch: b.branch })
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
