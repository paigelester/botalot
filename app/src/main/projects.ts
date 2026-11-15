import { dialog } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { Project } from '@shared/types'
import { loadConfig, saveConfig, type AppConfig } from './config'
import { isGitRepo } from './git'
import { hasGitHubRemote } from './github'

/** Palette of realm tints, assigned round-robin as projects are registered. */
export const TINTS = [0xe05a3a, 0x3a8fe0, 0x4fb563, 0xd8a53b, 0x9c5be0, 0x2fb8b0, 0xe0629c, 0xa0b23a, 0xc46f2f, 0x6c7be0]

export function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Try to decode a ~/.claude/projects folder name such as C--dev-foo into C:\dev\foo. Lossy. */
function naiveDecode(folder: string): string | null {
  const m = /^([A-Za-z])--(.*)$/.exec(folder)
  if (!m) return null
  return `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, '\\')}`
}

/** Read the real cwd out of the most recent session transcript in a Claude project folder. */
function cwdFromTranscripts(dir: string): string | null {
  let files: { name: string; mtime: number }[] = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return null
  }
  for (const f of files.slice(0, 3)) {
    try {
      const raw = readFileSync(join(dir, f.name), 'utf8')
      const lines = raw.split('\n', 40)
      for (const line of lines) {
        const idx = line.indexOf('"cwd":"')
        if (idx === -1) continue
        const rest = line.slice(idx + 7)
        const end = rest.indexOf('"')
        if (end === -1) continue
        const cwd = JSON.parse(`"${rest.slice(0, end)}"`) as string
        if (cwd) return cwd
      }
    } catch {
      /* ignore unreadable transcript */
    }
  }
  return null
}

/** Discover project paths Claude Code has been run in. */
export function discoverClaudeProjects(): string[] {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return []
  const found = new Map<string, string>()
  for (const folder of readdirSync(root)) {
    const dir = join(root, folder)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const cwd = cwdFromTranscripts(dir) ?? naiveDecode(folder)
    if (!cwd) continue
    const fixed = cwd.replace(/\//g, '\\')
    if (!existsSync(fixed)) continue
    found.set(normalizePath(fixed), fixed)
  }
  return [...found.values()]
}

export class ProjectStore extends EventEmitter {
  private cfg: AppConfig

  constructor() {
    super()
    this.cfg = loadConfig()
    this.refreshDiscovered()
  }

  private persist(): void {
    saveConfig(this.cfg)
    this.emit('changed', this.visible())
  }

  private nextTint(): number {
    const used = new Set(this.cfg.projects.map((p) => p.tint))
    return TINTS.find((t) => !used.has(t)) ?? TINTS[this.cfg.projects.length % TINTS.length]
  }

  private register(path: string, source: Project['source']): Project {
    const existing = this.cfg.projects.find((p) => normalizePath(p.path) === normalizePath(path))
    if (existing) {
      existing.isGit = isGitRepo(existing.path)
      return existing
    }
    const project: Project = {
      id: randomUUID(),
      path,
      name: basename(path) || path,
      tint: this.nextTint(),
      worktreeLayout: 'sibling',
      hidden: false,
      isGit: isGitRepo(path),
      source
    }
    this.cfg.projects.push(project)
    return project
  }

  refreshDiscovered(): void {
    if (process.env.DRAGON_DEMO) return // the demo kingdom is scripted; never pull in real projects
    let changed = false
    const ignored = new Set(this.cfg.ignored ?? [])
    for (const path of discoverClaudeProjects()) {
      if (ignored.has(normalizePath(path))) continue
      const before = this.cfg.projects.length
      this.register(path, 'discovered')
      if (this.cfg.projects.length !== before) changed = true
    }
    // Drop discovered projects whose folders vanished. Manual ones stay so the user can see the problem.
    const kept = this.cfg.projects.filter((p) => p.source === 'manual' || existsSync(p.path))
    if (kept.length !== this.cfg.projects.length) {
      this.cfg.projects = kept
      changed = true
    }
    if (changed) saveConfig(this.cfg)
  }

  /** Fill in trackers for realms that have none yet: github when origin is on github.com, otherwise none. */
  async inferTrackers(): Promise<void> {
    let changed = false
    for (const p of this.cfg.projects) {
      if (p.tracker) continue
      p.tracker = p.isGit && (await hasGitHubRemote(p.path)) ? { kind: 'github' } : { kind: 'none' }
      changed = true
    }
    if (changed) this.persist()
  }

  all(): Project[] {
    return this.cfg.projects
  }

  visible(): Project[] {
    return this.cfg.projects.filter((p) => !p.hidden)
  }

  get(id: string): Project | undefined {
    return this.cfg.projects.find((p) => p.id === id)
  }

  async addViaDialog(): Promise<Project | null> {
    const res = await dialog.showOpenDialog({ title: 'Choose a realm (project folder)', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const project = this.register(res.filePaths[0], 'manual')
    project.hidden = false
    this.cfg.ignored = (this.cfg.ignored ?? []).filter((p) => p !== normalizePath(project.path))
    this.persist()
    return project
  }

  /** Delete a realm from the kingdom. Discovered realms are remembered as ignored so they stay gone. */
  remove(id: string): Project[] {
    const p = this.get(id)
    if (p) {
      this.cfg.projects = this.cfg.projects.filter((x) => x.id !== id)
      const ignored = new Set(this.cfg.ignored ?? [])
      ignored.add(normalizePath(p.path))
      this.cfg.ignored = [...ignored]
    }
    this.persist()
    return this.all()
  }

  update(id: string, patch: Partial<Pick<Project, 'name' | 'tint' | 'worktreeLayout' | 'hidden' | 'tracker' | 'patrol'>>): Project[] {
    const p = this.get(id)
    if (p) Object.assign(p, patch)
    this.persist()
    return this.all()
  }
}
