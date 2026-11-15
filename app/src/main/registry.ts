import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'

/** Shape of ~/.claude/sessions/<pid>.json as written by Claude Code. */
export interface RegistryEntry {
  pid: number
  sessionId?: string
  cwd?: string
  startedAt?: number | string
  status?: string
  name?: string
}

/** Watches Claude Code's live session registry and emits the full set on every change. */
export class RegistryWatcher extends EventEmitter {
  private dir = join(homedir(), '.claude', 'sessions')
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  start(): void {
    const tick = () => this.emit('registry', this.read())
    if (existsSync(this.dir)) {
      try {
        this.watcher = watch(this.dir, () => tick())
      } catch {
        /* fall back to polling only */
      }
    }
    this.timer = setInterval(tick, 3000)
    tick()
  }

  stop(): void {
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
  }

  read(): RegistryEntry[] {
    if (!existsSync(this.dir)) return []
    const out: RegistryEntry[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const entry = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as RegistryEntry
        if (entry && typeof entry.pid === 'number') out.push(entry)
      } catch {
        /* partially written file; skip */
      }
    }
    return out
  }
}
