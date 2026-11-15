import { execFile } from 'child_process'
import type { CiStatus, Issue, IssueList, PullRequestInfo } from '@shared/types'

const LIMIT = 100

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr?.toString() || err.message).trim()))
      else resolve(stdout.toString())
    })
  })
}

/** Does the repo's origin point at GitHub? Used to infer a realm's tracker. */
export async function hasGitHubRemote(cwd: string): Promise<boolean> {
  try {
    const url = await run('git', ['remote', 'get-url', 'origin'], cwd)
    return /github\.com/i.test(url)
  } catch {
    return false
  }
}

/** Open issues for the repo at cwd, via the GitHub CLI. With `search`, uses GitHub's issue search. Never throws. */
export async function listGitHubIssues(cwd: string, search?: string): Promise<IssueList> {
  try {
    const args = ['issue', 'list', '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,body,labels,assignees,updatedAt,url']
    const q = search?.trim()
    if (q) args.push('--search', /^#?\d+$/.test(q) ? q.replace('#', '') : `${q} in:title,body`)
    const out = await run('gh', args, cwd)
    const raw = JSON.parse(out) as Array<{
      number: number
      title: string
      body: string
      labels: { name: string }[]
      assignees: { login: string }[]
      updatedAt: string
      url: string
    }>
    const issues: Issue[] = raw.map((i) => ({
      key: String(i.number),
      title: i.title,
      body: i.body ?? '',
      labels: (i.labels ?? []).map((l) => l.name),
      assignees: (i.assignees ?? []).map((a) => a.login),
      updatedAt: i.updatedAt,
      url: i.url
    }))
    return { tracker: 'github', issues, truncated: issues.length >= LIMIT }
  } catch (err) {
    const msg = (err as Error).message
    let friendly = msg.split('\n')[0] || 'gh failed'
    if (/not recognized|ENOENT|not found/i.test(msg)) friendly = 'GitHub CLI (gh) is not installed or not on PATH.'
    else if (/known GitHub host|no git remotes|not a git repository|could not determine/i.test(msg)) friendly = 'This realm has no GitHub remote.'
    else if (/auth login|not logged in/i.test(msg)) friendly = 'GitHub CLI is not logged in. Run: gh auth login'
    return { tracker: 'github', issues: [], error: friendly }
  }
}

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun (status, conclusion) or a StatusContext (state). */
interface RollupEntry {
  __typename?: string
  status?: string
  conclusion?: string
  state?: string
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Any failure is a fail; otherwise anything unfinished is pending; otherwise pass. Skipped and neutral checks count as passed. */
export function ciStatus(rollup: RollupEntry[] | null | undefined): CiStatus {
  if (!rollup || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const result = (c.conclusion || c.state || '').toUpperCase()
    if (FAILED.has(result)) return 'fail'
    const finished = c.__typename === 'StatusContext' ? result !== 'PENDING' && result !== 'EXPECTED' && result !== '' : (c.status || '').toUpperCase() === 'COMPLETED'
    if (!finished) pending = true
  }
  return pending ? 'pending' : 'pass'
}

/** The pull request whose head is `branch` in the repo at cwd, or null when there is none or gh can't tell. Never throws. */
export async function pullRequestFor(cwd: string, branch: string): Promise<PullRequestInfo | null> {
  try {
    // The branch name goes to gh as an argument, so no shell (branch names may hold & or |), and never as an option.
    if (!branch || branch.startsWith('-')) return null
    const out = await new Promise<string>((resolve, reject) =>
      execFile('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft,statusCheckRollup'], { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout.toString())
      )
    )
    const raw = JSON.parse(out) as { number: number; url: string; state: PullRequestInfo['state']; isDraft: boolean; statusCheckRollup?: RollupEntry[] }
    return { number: raw.number, url: raw.url, state: raw.state, draft: !!raw.isDraft, ci: ciStatus(raw.statusCheckRollup) }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ patrol

/** gh without a shell: issue text and labels go in as plain arguments, never parsed by cmd.exe. Rejects on failure. */
function gh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('gh', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr?.toString() || err.message).trim())) : resolve(stdout.toString())
    )
  )
}

export async function githubRelabel(cwd: string, key: string, remove: string[], add: string[]): Promise<void> {
  const args = ['issue', 'edit', key]
  for (const l of remove) args.push('--remove-label', l)
  for (const l of add) args.push('--add-label', l)
  await gh(args, cwd)
}

export async function githubComment(cwd: string, key: string, text: string): Promise<void> {
  await gh(['issue', 'comment', key, '--body', text], cwd)
}

/** Create any of these labels the repo doesn't have yet. */
export async function githubEnsureLabels(cwd: string, labels: { name: string; color: string; description: string }[]): Promise<void> {
  const out = await gh(['label', 'list', '--limit', '500', '--json', 'name'], cwd)
  const have = new Set((JSON.parse(out) as { name: string }[]).map((l) => l.name.toLowerCase()))
  for (const l of labels) if (!have.has(l.name.toLowerCase())) await gh(['label', 'create', l.name, '--color', l.color, '--description', l.description], cwd)
}
