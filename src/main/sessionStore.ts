import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentKind } from '@shared/types'
import { configDir } from './config'

/** What we remember about a dragon so it can come back after a restart. Written on creation, updated as it changes. */
export interface SessionRecord {
  id: string
  name: string
  agent: AgentKind
  projectId: string
  cwd: string
  branch: string
  isWorktree: boolean
  startedAt: number
  /** The agent's own session id, once known. */
  agentSessionId?: string
  /** Set for a background dragon: its `claude agents` id. Absent for dragons that run in the app's pty. */
  backgroundId?: string
  lastSeenAt: number
}

function file(): string {
  return join(configDir(), 'sessions.json')
}

export function loadSessionRecords(): SessionRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { sessions?: SessionRecord[] }
    // Records from earlier versions may name an agent the app no longer runs; those dragons are left behind.
    return Array.isArray(parsed.sessions) ? parsed.sessions.filter((r) => r.agent === 'claude') : []
  } catch {
    return []
  }
}

export function saveSessionRecords(records: SessionRecord[]): void {
  try {
    writeFileSync(file(), JSON.stringify({ sessions: records }, null, 2), 'utf8')
  } catch (err) {
    console.warn('could not save session records', err)
  }
}
