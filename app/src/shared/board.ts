/**
 * A realm's board (the tickets waiting on you) and what is due (the runs that should be started), as the
 * botalot CLI prints them with `board --json` and `due --json`. Pure, so it is testable: imports nothing.
 */

export interface BoardTicket {
  number: number
  title: string
  url: string
}

/** A ticket a route run has judged: it has an owner and a plan, and waits for your approval. */
export interface RoutedTicket extends BoardTicket {
  owner: 'agent-owned' | 'human-owned'
  /** The routing plan comment, as markdown; null when the owner label was set by hand. */
  plan: string | null
}

export interface Board {
  toApprove: RoutedTicket[]
  needsYou: BoardTicket[]
  yoursToBuild: BoardTicket[]
  inReview: BoardTicket[]
  /** Written up and waiting for you to pick one to work on. */
  refined: BoardTicket[]
}

/** A run that should be started: a ticket whose labels match a workflow's trigger. */
export interface Due extends BoardTicket {
  workflow: string
  /** work changes code (a dragon); planning decides things (a goblin). */
  kind: 'work' | 'planning'
  /** holding: a worktree of its own. main: the realm's main checkout. */
  where: 'holding' | 'main'
  /** The branch the run belongs on, when it already exists: a fix round on an open pull request. */
  branch?: string
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function ticket(v: unknown): BoardTicket | null {
  const t = obj(v)
  return typeof t.number === 'number' && typeof t.title === 'string' ? { number: t.number, title: t.title, url: typeof t.url === 'string' ? t.url : '' } : null
}

const tickets = (v: unknown): BoardTicket[] => (Array.isArray(v) ? v.map(ticket).filter((t): t is BoardTicket => !!t) : [])

/** Read `botalot board --json`. Null when it isn't a board (the CLI printed an error instead). */
export function parseBoard(json: unknown): Board | null {
  const b = obj(json)
  if (!Array.isArray(b.toApprove)) return null
  const toApprove: RoutedTicket[] = []
  for (const raw of b.toApprove) {
    const t = ticket(raw)
    const r = obj(raw)
    if (!t || (r.owner !== 'agent-owned' && r.owner !== 'human-owned')) continue
    toApprove.push({ ...t, owner: r.owner, plan: typeof r.plan === 'string' ? r.plan : null })
  }
  return { toApprove, needsYou: tickets(b.needsYou), yoursToBuild: tickets(b.yoursToBuild), inReview: tickets(b.inReview), refined: tickets(b.refined) }
}

/** Read `botalot due --json`. Entries that aren't well formed are dropped. */
export function parseDue(json: unknown): Due[] {
  if (!Array.isArray(json)) return []
  const out: Due[] = []
  for (const raw of json) {
    const t = ticket(raw)
    const d = obj(raw)
    if (!t || typeof d.workflow !== 'string') continue
    out.push({ ...t, workflow: d.workflow, kind: d.kind === 'planning' ? 'planning' : 'work', where: d.where === 'main' ? 'main' : 'holding', ...(typeof d.branch === 'string' && d.branch ? { branch: d.branch } : {}) })
  }
  return out
}

/** How many things on a board are yours to decide right now: the tickets to approve. */
export function boardCount(board: Board | undefined): number {
  return board?.toApprove.length ?? 0
}
