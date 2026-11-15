// What a patrol dragon may do without asking. Shared by the Realms dialog (to prefill) and the main process.

/**
 * Shell commands a patrol dragon runs without asking, in Claude Code's rule syntax (`*` matches anything).
 * Enough to go from ticket to pull request: run the checks, commit, push, open the PR, move the ticket's labels
 * and comment on it. File edits are
 * accepted separately (acceptEdits); anything else still asks and shows up as awaiting you.
 */
export const DEFAULT_PATROL_ALLOW = [
  'npm run verify',
  'npm test',
  'git add *',
  'git commit *',
  'git push *',
  'gh issue view *',
  'gh issue edit *',
  'gh issue comment *',
  'gh pr view *',
  'gh pr create *'
]

/** One command pattern per line, cleaned: blank lines dropped, and a pasted `Bash(...)` wrapper unwrapped. */
export function parseAllowList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^Bash\((.*)\)$/, '$1').trim())
    .filter((l) => l.length > 0)
}

/** Claude Code settings that let a patrol dragon work unattended within its allow list. */
export function patrolPermissions(allow: string[]): { defaultMode: 'acceptEdits'; allow: string[] } {
  return { defaultMode: 'acceptEdits', allow: allow.map((c) => `Bash(${c})`) }
}
