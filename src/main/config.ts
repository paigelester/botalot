import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Project } from '@shared/types'

export interface AppConfig {
  projects: Project[]
  /** Normalised paths the user removed; discovery must not bring them back. */
  ignored: string[]
  /** When a dragon counts as stuck. Edit config.json to change; missing values use the defaults. */
  stuck?: Partial<StuckThresholds>
}

export interface StuckThresholds {
  /** A working dragon with no hook event (or, without hooks, no output) for this long is stuck. */
  workingQuietMinutes: number
  /** A dragon waiting on you for longer than this is stuck. */
  waitingMinutes: number
}

const defaults: AppConfig = { projects: [], ignored: [] }

export const DEFAULT_STUCK: StuckThresholds = { workingQuietMinutes: 10, waitingMinutes: 15 }

export function stuckThresholds(): StuckThresholds {
  const s = loadConfig().stuck ?? {}
  const pick = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d)
  return {
    workingQuietMinutes: pick(s.workingQuietMinutes, DEFAULT_STUCK.workingQuietMinutes),
    waitingMinutes: pick(s.waitingMinutes, DEFAULT_STUCK.waitingMinutes)
  }
}

let migrated = false

/**
 * The app was called Dragon Kingdom before it was Botalot, and Electron names the config
 * folder after the app. On first run under the new name, carry the old folder's config,
 * secrets and dragon records across so nothing is lost.
 */
function migrateFromDragonKingdom(dir: string): void {
  if (migrated) return
  migrated = true
  try {
    if (existsSync(join(dir, 'config.json'))) return
    const old = join(dirname(dir), 'dragon-kingdom')
    if (!existsSync(join(old, 'config.json'))) return
    for (const f of ['config.json', 'secrets.json', 'sessions.json']) {
      if (existsSync(join(old, f))) copyFileSync(join(old, f), join(dir, f))
    }
    writeFileSync(join(old, 'MOVED-TO-BOTALOT.txt'), `This app is now called Botalot. Its settings moved to ${dir} on ${new Date().toISOString()}.\n`, 'utf8')
    console.log('migrated settings from', old, 'to', dir)
  } catch (err) {
    console.warn('could not migrate old Dragon Kingdom settings', err)
  }
}

export function configDir(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  migrateFromDragonKingdom(dir)
  return dir
}

export function configPath(): string {
  return join(configDir(), 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

export function saveConfig(cfg: AppConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
}
