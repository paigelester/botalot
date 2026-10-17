import { execFile } from 'child_process'
import type { Issue, IssueList } from '@shared/types'

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
