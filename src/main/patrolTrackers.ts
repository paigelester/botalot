import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/types'
import { configDir } from './config'
import { githubComment, githubEnsureLabels, githubLabels, githubOldestWithLabels, githubRelabel } from './github'
import { LABEL, type AttemptStore, type PatrolTracker } from './patrol'

/** The labels patrol uses, created on GitHub when missing. Same colours as the setup-factory skill's setup.sh. */
const GITHUB_LABELS = [
  { name: LABEL.ready, color: '0E8A16', description: 'Approved to build' },
  { name: LABEL.agent, color: '006B75', description: 'An agent builds it' },
  { name: LABEL.working, color: 'FBCA04', description: 'Being built' },
  { name: LABEL.review, color: '1D76DB', description: 'PR open and under review' },
  { name: LABEL.blocked, color: 'B60205', description: 'Agent stopped: no access, secret or service' }
]

/** The realm's tracker as patrol sees it: GitHub issues through gh. */
export function patrolTrackerFor(p: Project): PatrolTracker | null {
  const t = p.tracker
  if (t?.kind === 'github') {
    return {
      oldestReady: () => githubOldestWithLabels(p.path, [LABEL.ready, LABEL.agent]),
      labels: (key) => githubLabels(p.path, key),
      relabel: (key, remove, add) => githubRelabel(p.path, key, remove, add),
      comment: (key, text) => githubComment(p.path, key, text),
      ensureLabels: () => githubEnsureLabels(p.path, GITHUB_LABELS)
    }
  }
  return null
}

/** Attempt counts in patrol.json in the config folder, so "retry once" holds across restarts. */
export function fileAttemptStore(): AttemptStore {
  const file = join(configDir(), 'patrol.json')
  let counts: Record<string, number> = {}
  try {
    counts = (JSON.parse(readFileSync(file, 'utf8')) as { attempts?: Record<string, number> }).attempts ?? {}
  } catch {
    /* first run */
  }
  return {
    get: (key) => counts[key] ?? 0,
    set: (key, n) => {
      counts[key] = n
      try {
        writeFileSync(file, JSON.stringify({ attempts: counts }, null, 2), 'utf8')
      } catch (err) {
        console.warn('could not save patrol attempts', err)
      }
    }
  }
}
