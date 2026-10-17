import { execFile } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { GitInfo, Worktree, WorktreeLayout } from '@shared/types'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString() || err.message))
      else resolve(stdout.toString())
    })
  })
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'))
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    const out = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return out.trim()
  } catch {
    return ''
  }
}

const BACKSLASH = String.fromCharCode(92)

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  if (!isGitRepo(repo)) return []
  let out = ''
  try {
    out = await git(repo, ['worktree', 'list', '--porcelain'])
  } catch {
    return []
  }
  const trees: Worktree[] = []
  let current: Partial<Worktree> | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current?.path) trees.push(finish(current))
      current = { path: line.slice('worktree '.length).split('/').join(BACKSLASH), isMain: trees.length === 0 }
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'detached' && current) {
      current.branch = '(detached)'
    }
  }
  if (current?.path) trees.push(finish(current))
  return trees

  function finish(w: Partial<Worktree>): Worktree {
    return { path: w.path!, branch: w.branch ?? '(unknown)', isMain: !!w.isMain }
  }
}

function sanitizeBranchForPath(branch: string): string {
  const cleaned = branch
    .split('')
    .map((ch) => ('/:*?"<>|'.includes(ch) || ch === BACKSLASH ? '-' : ch))
    .join('')
  return cleaned.replace(/^-+|-+$/g, '') || 'worktree'
}

export function worktreePathFor(repo: string, branch: string, layout: WorktreeLayout, folder?: string): string {
  const leaf = sanitizeBranchForPath(folder?.trim() || branch)
  if (layout === 'inside') return join(repo, '.claude', 'worktrees', leaf)
  return join(dirname(repo), `${basename(repo)}-worktrees`, leaf)
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** The remote's default branch as a local ref name such as origin/main, or null without a remote. */
export async function remoteDefaultBranch(repo: string): Promise<string | null> {
  try {
    const out = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ref = out.trim().replace(/^refs\/remotes\//, '')
    if (ref) return ref
  } catch {
    /* origin/HEAD not recorded; guess below */
  }
  for (const guess of ['origin/main', 'origin/master']) {
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${guess}`])
      return guess
    } catch {
      /* try next */
    }
  }
  return null
}

export interface WorktreeBase {
  /** Start point used for the new branch, e.g. origin/main or HEAD. */
  startPoint: string
  /** True when the remote was fetched and the branch starts from it. */
  fromRemote: boolean
  /** Why we fell back to local HEAD, when we did. */
  note?: string
}

/**
 * Work out where a new branch should start. Fetches origin so the start point is the
 * latest remote default branch; falls back to local HEAD when offline or remote-less.
 */
export async function resolveWorktreeBase(repo: string): Promise<WorktreeBase> {
  let remote = await remoteDefaultBranch(repo)
  if (!remote) {
    try {
      await git(repo, ['remote', 'get-url', 'origin'])
    } catch {
      return { startPoint: 'HEAD', fromRemote: false, note: 'No origin remote; branching from local HEAD.' }
    }
  }
  try {
    await git(repo, ['fetch', '--quiet', '--prune', 'origin'])
  } catch (err) {
    return { startPoint: 'HEAD', fromRemote: false, note: `Fetch failed (${(err as Error).message.trim().split('\n')[0]}); branching from local HEAD.` }
  }
  if (!remote) {
    try {
      await git(repo, ['remote', 'set-head', 'origin', '--auto'])
    } catch {
      /* leave remote null */
    }
    remote = await remoteDefaultBranch(repo)
  }
  if (!remote) return { startPoint: 'HEAD', fromRemote: false, note: 'Could not find a default branch on origin; branching from local HEAD.' }
  return { startPoint: remote, fromRemote: true }
}

export async function addWorktree(
  repo: string,
  branch: string,
  layout: WorktreeLayout,
  folder?: string
): Promise<Worktree & { base?: WorktreeBase }> {
  const path = worktreePathFor(repo, branch, layout, folder)
  if (existsSync(path)) {
    // Already there: just reuse it.
    return { path, branch, isMain: false }
  }
  mkdirSync(dirname(path), { recursive: true })
  if (await branchExists(repo, branch)) {
    await git(repo, ['worktree', 'add', path, branch])
    return { path, branch, isMain: false }
  }
  const base = await resolveWorktreeBase(repo)
  // --no-track: the new branch must not have origin/main as upstream, or `git push` would target main.
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, base.startPoint])
  return { path, branch, isMain: false, base }
}

export async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const out = await git(cwd, ['status', '--porcelain=v1', '-b'])
    const info: GitInfo = { branch: '', staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 }
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue
      if (line.startsWith('## ')) {
        const head = line.slice(3)
        info.branch = head.split('...')[0].replace(/^No commits yet on /, '')
        const ahead = /ahead (\d+)/.exec(head)
        const behind = /behind (\d+)/.exec(head)
        if (ahead) info.ahead = Number(ahead[1])
        if (behind) info.behind = Number(behind[1])
        continue
      }
      const x = line[0]
      const y = line[1]
      if (x === '?' && y === '?') info.untracked++
      else {
        if (x !== ' ' && x !== '?') info.staged++
        if (y !== ' ') info.modified++
      }
    }
    return info
  } catch {
    return undefined
  }
}
