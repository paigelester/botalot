// Each realm's board: the tickets waiting on you, as the botalot CLI reads them off GitHub (`board --json`).
import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Project } from '@shared/types'
import { parseBoard, type Board } from '@shared/board'
import { cli } from './runs'

const POLL_MS = 2 * 60_000

/** Whether a realm runs the factory at all: on GitHub, with a contract. Others have no board. */
export function hasFactory(p: Project): boolean {
  return p.isGit && p.tracker?.kind === 'github' && existsSync(join(p.path, '.factory', 'contract.json'))
}

/**
 * Keeps every realm's board, by realm id, and emits `boards` (all of them) when one changes. Each poll is a
 * couple of `gh` calls per realm, so it runs every two minutes and straight after anything that changes a board.
 */
export class BoardWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private boards: Record<string, Board> = {}
  private polling = false
  private projects: () => Project[]

  constructor(projects: () => Project[]) {
    super()
    this.projects = projects
  }

  start(): void {
    // DRAGON_DEMO_BOARDS=<json file> stands in for GitHub in the demo kingdom, whose realms are fictional.
    const demo = process.env.DRAGON_DEMO_BOARDS
    if (demo) {
      this.boards = JSON.parse(readFileSync(demo, 'utf8')) as Record<string, Board>
      setTimeout(() => this.emit('boards', this.all()), 3000)
      return
    }
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  all(): Record<string, Board> {
    return { ...this.boards }
  }

  /** Read every realm's board now, or just one realm's. Never overlaps itself. */
  async poll(only?: string): Promise<void> {
    if (this.polling || process.env.DRAGON_DEMO_BOARDS) return
    this.polling = true
    try {
      const before = JSON.stringify(this.boards)
      const realms = this.projects()
      for (const p of realms) {
        if (only && p.id !== only) continue
        if (!hasFactory(p)) {
          delete this.boards[p.id]
          continue
        }
        const { code, stdout } = await cli(['board', '--json'], p.path, p.path)
        if (code !== 0) continue // gh offline or signed out: keep what was last known
        try {
          const board = parseBoard(JSON.parse(stdout))
          if (board) this.boards[p.id] = board
        } catch {
          /* not JSON: keep what was last known */
        }
      }
      for (const id of Object.keys(this.boards)) if (!realms.some((p) => p.id === id)) delete this.boards[id]
      if (JSON.stringify(this.boards) !== before) this.emit('boards', this.all())
    } finally {
      this.polling = false
    }
  }
}
