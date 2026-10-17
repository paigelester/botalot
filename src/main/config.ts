import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Project } from '@shared/types'

export interface AppConfig {
  projects: Project[]
  /** Normalised paths the user removed; discovery must not bring them back. */
  ignored: string[]
}

const defaults: AppConfig = { projects: [], ignored: [] }

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
