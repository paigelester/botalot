import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import { childEnv, resolveOnPath } from './agents'

const POLL_MS = 3000
const COMMAND_TIMEOUT_MS = 15_000

/**
 * One background session as printed by `claude agents --json --all` (Claude Code 2.1).
 * Interactive sessions appear in the same list without `id` or `state`; only background ones are kept.
 */
export interface BackgroundEntry {
  /** Short id that `claude attach` takes. */
  id: string
  pid?: number
  cwd: string
  startedAt?: number
  /** The agent's own session id (a UUID), the same one hooks report. */
  sessionId?: string
  name?: string
  /** working / blocked / done / failed / stopped. */
  state?: string
  /** busy / waiting / idle. */
  status?: string
  /** Present while blocked: what the session waits for. */
  waitingFor?: unknown
}

/** Polls Claude Code's background sessions and emits the full list after every poll. */
export class BackgroundWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private running = false

  start(): void {
    const tick = () => void this.poll()
    this.timer = setInterval(tick, POLL_MS)
    tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      this.emit('background', await listBackground())
    } finally {
      this.running = false
    }
  }
}

/** Every background session, or an empty list when claude is missing or the command fails. */
export async function listBackground(): Promise<BackgroundEntry[]> {
  const binary = process.env.DRAGON_CLAUDE_BIN || resolveOnPath('claude')
  if (!binary) return []
  let file = binary
  let args = ['agents', '--json', '--all']
  if (/\.c?js$/i.test(file)) {
    args = [file, ...args]
    file = resolveOnPath('node') ?? 'node'
  }
  const out = await new Promise<string | null>((resolve) => {
    execFile(file, args, { env: childEnv(), windowsHide: true, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
  if (!out) return []
  try {
    const parsed = JSON.parse(out) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is BackgroundEntry => !!e && typeof e === 'object' && e.kind === 'background' && typeof e.id === 'string' && typeof e.cwd === 'string'
    )
  } catch {
    return []
  }
}
