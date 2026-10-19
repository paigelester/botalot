import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/types'
import { configDir } from './config'
import { githubComment, githubEnsureLabels, githubLabels, githubOldestWithLabel, githubRelabel } from './github'
import { jiraComment, jiraLabels, jiraOldestWithLabel, jiraRelabel } from './jira'
import { LABEL, type AttemptStore, type PatrolTracker } from './patrol'

/** Colours and descriptions for the labels patrol adds on GitHub. ready-for-agent and ready-for-human already exist in triage. */
const GITHUB_LABELS = [
  { name: LABEL.ready, color: 'D93F0B', description: 'Fully specified, ready for an AFK agent' },
  { name: LABEL.working, color: 'FBCA04', description: 'A Botalot patrol dragon is working on it' },
  { name: LABEL.done, color: '0E8A16', description: 'A Botalot patrol dragon opened a pull request' },
  { name: LABEL.human, color: 'B60205', description: 'Requires human implementation' }
]

/** The realm's tracker as patrol sees it: GitHub issues through gh, or Jira issues through its REST API. */
export function patrolTrackerFor(p: Project): PatrolTracker | null {
  const t = p.tracker
  if (t?.kind === 'github') {
    return {
      oldestReady: () => githubOldestWithLabel(p.path, LABEL.ready),
      labels: (key) => githubLabels(p.path, key),
      relabel: (key, remove, add) => githubRelabel(p.path, key, remove, add),
      comment: (key, text) => githubComment(p.path, key, text),
      ensureLabels: () => githubEnsureLabels(p.path, GITHUB_LABELS)
    }
  }
  if (t?.kind === 'jira' && t.site && t.projectKey) {
    return {
      oldestReady: () => jiraOldestWithLabel(t, LABEL.ready),
      labels: (key) => jiraLabels(t, key),
      relabel: (key, remove, add) => jiraRelabel(t, key, remove, add),
      comment: (key, text) => jiraComment(t, key, text),
      // Jira creates a label the first time an issue gets it.
      ensureLabels: async () => {}
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
