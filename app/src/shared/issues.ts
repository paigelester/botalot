// Turning a tracker issue into a holding: its branch name and the dragon's opening prompt.
// Shared by the Summon dialog (issues picked by hand) and patrol (which names a ticket's holding the same way).
import type { Issue, Tracker } from './types.ts'

export const TRACKER_NAME: Record<Tracker['kind'], string> = { none: 'tracker', github: 'GitHub' }

/** Branch-safe slug from an issue title: drops leading tags like [WORK] or (You), cuts at a word boundary. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .replace(/^(\s*(\[[^\]]*\]|\([^)]*\)))+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max + 1)
  const atWord = cut.lastIndexOf('-')
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut.slice(0, max)).replace(/-+$/g, '')
}

export function issueBranch(issue: Pick<Issue, 'key' | 'title'>): string {
  return `${issue.key}-${slugify(issue.title)}`
}

function issueRef(issue: Issue, tracker: Tracker['kind']): string {
  return tracker === 'github' ? `GitHub issue #${issue.key}` : `${TRACKER_NAME[tracker]} issue ${issue.key}`
}

function issueText(issue: Issue, tracker: Tracker['kind']): string {
  const body = issue.body.trim()
  const link = issue.url ? `\n${issue.url}` : ''
  return `${issueRef(issue, tracker)}: ${issue.title}${link}\n\n${body || '(no description)'}`
}

/** Opening prompt for a dragon you summon onto an issue yourself: it proposes a plan and waits for you. */
export function issuePrompt(issue: Issue, tracker: Tracker['kind']): string {
  return `Work on ${issueText(issue, tracker)}\n\nThis worktree is on branch ${issueBranch(issue)}. Start by reading the relevant code and proposing a short plan before changing anything.`
}
