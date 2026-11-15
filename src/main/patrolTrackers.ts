import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/types'
import { configDir } from './config'
import { githubComment, githubEnsureLabels, githubRelabel, githubWithLabels } from './github'
import { LABEL, type PatrolMemory, type PatrolTracker } from './patrol'

/** The labels patrol writes, created on GitHub when missing. Same colours as the factory's own (`factory labels`). */
const GITHUB_LABELS = [
  { name: LABEL.ready, color: '0E8A16', description: 'Approved to build' },
  { name: LABEL.needsYou, color: 'D93F0B', description: 'The agent needs a decision or access; the reason is in the comment' }
]

/** The realm's tracker as patrol sees it: GitHub issues through gh. */
export function patrolTrackerFor(p: Project): PatrolTracker | null {
  const t = p.tracker
  if (t?.kind === 'github') {
    return {
      ready: () => githubWithLabels(p.path, [LABEL.ready, LABEL.agent]),
      relabel: (key, remove, add) => githubRelabel(p.path, key, remove, add),
      comment: (key, text) => githubComment(p.path, key, text),
      ensureLabels: () => githubEnsureLabels(p.path, GITHUB_LABELS)
    }
  }
  return null
}

/** Patrol's memory in patrol.json in the config folder, so "try once more" and "already told you" hold across restarts. */
export function filePatrolMemory(): PatrolMemory {
  const file = join(configDir(), 'patrol.json')
  let attempts: Record<string, number> = {}
  let settled: string[] = []
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { attempts?: Record<string, number>; settled?: string[] }
    attempts = saved.attempts ?? {}
    settled = saved.settled ?? []
  } catch {
    /* first run */
  }
  const save = (): void => {
    try {
      // Only the latest runs are worth remembering: older ones have long since left the runs folder's recent list.
      writeFileSync(file, JSON.stringify({ attempts, settled: settled.slice(-200) }, null, 2), 'utf8')
    } catch (err) {
      console.warn('could not save patrol memory', err)
    }
  }
  return {
    attempts: (key) => attempts[key] ?? 0,
    setAttempts: (key, n) => {
      attempts[key] = n
      save()
    },
    settled: (runId) => settled.includes(runId),
    settle: (runId) => {
      settled.push(runId)
      save()
    }
  }
}
