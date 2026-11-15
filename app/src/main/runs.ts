// Runs: watching the driver's runs folder, and starting, carrying on and stopping runs through the botalot CLI
// (bin/botalot.mjs at the repo root). The app holds no run logic of its own: the driver decides every step.
import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Quota } from '@shared/quota'
import { buildRunView, parseRunLog, type RunView } from '@shared/runs'

const POLL_MS = 3000
/** Finished runs older than this many newest files are left out, so a long history never slows the poll. */
const MAX_RUNS = 60

/** The driver's home: run logs, run state and the latest quota reading. The driver reads the same variable. */
export function botalotHome(): string {
  return process.env.BOTALOT_HOME || join(homedir(), '.botalot')
}

function runsDir(): string {
  return join(botalotHome(), 'runs')
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Polls the runs folder and emits `runs` (every run, newest first) whenever something changed. Polling rather
 * than fs.watch: the driver appends to its log many times a second, and watch events on Windows are unreliable.
 */
export class RunsWatcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private cache = new Map<string, { stamp: string; view: RunView }>()
  private last = ''

  start(): void {
    this.poll()
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): RunView[] {
    return [...this.cache.values()].map((c) => c.view).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): RunView | undefined {
    return this.cache.get(id)?.view
  }

  /** Read the folder now. Called on the timer, and straight after Botalot starts or carries on a run. */
  poll(): void {
    const dir = runsDir()
    const seen = new Set<string>()
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ id: n.slice(0, -5), at: mtime(join(dir, n)) }))
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_RUNS)
      for (const { id, at } of files) {
        seen.add(id)
        try {
          const state: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
          const isAlive = (state as { status?: string }).status === 'running' && alive((state as { pid?: unknown }).pid)
          const stamp = `${at}:${mtime(join(dir, `${id}.jsonl`))}:${isAlive}`
          if (this.cache.get(id)?.stamp === stamp) continue
          const logPath = join(dir, `${id}.jsonl`)
          const view = buildRunView(state, existsSync(logPath) ? parseRunLog(readFileSync(logPath, 'utf8')) : [], isAlive)
          if (view) this.cache.set(id, { stamp, view })
        } catch {
          /* a state file caught mid-write: the next poll reads it whole */
        }
      }
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id)
    const now = [...this.cache.entries()].map(([id, c]) => id + c.stamp).join('|')
    if (now === this.last) return
    this.last = now
    this.emit('runs', this.list())
  }
}

/**
 * The CLI to run for a repo. A repo that installs botalot pins its own version, and its contract expects that
 * version, so its copy wins. Otherwise the one that ships with the app: beside the packaged app (electron-builder
 * copies it there), or the repo root above app/ in development.
 */
function cliFor(mainRepo?: string): string {
  const own = mainRepo ? join(mainRepo, 'node_modules', 'botalot', 'bin', 'botalot.mjs') : ''
  if (own && existsSync(own)) return own
  return app.isPackaged ? join(process.resourcesPath, 'cli', 'bin', 'botalot.mjs') : join(app.getAppPath(), '..', 'bin', 'botalot.mjs')
}

/**
 * Run the driver. The app's own executable runs the CLI as plain Node (ELECTRON_RUN_AS_NODE), so no separate
 * Node install is needed, detached with its output in a file so a run keeps going when Botalot quits. `onExit`
 * gets the exit code and the tail of what it printed: exit 0 = done or waiting on the human's own step,
 * 2 = it needs you, 1 = it could not run.
 */
function driver(args: string[], cwd: string, mainRepo: string | undefined, onExit?: (code: number, output: string) => void): void {
  mkdirSync(runsDir(), { recursive: true })
  const outPath = join(runsDir(), `botalot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
  const out = openSync(outPath, 'a')
  const child = spawn(process.execPath, [cliFor(mainRepo), ...args], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out]
  })
  const finish = (code: number): void => {
    let output = ''
    try {
      output = readFileSync(outPath, 'utf8').slice(-4000).trim()
    } catch {
      /* nothing was printed */
    }
    onExit?.(code, output)
  }
  child.on('error', (err) => {
    writeFileSync(outPath, `Could not start the driver: ${err.message}\n`)
    finish(1)
  })
  child.on('exit', (code) => finish(code ?? 1))
  closeSync(out)
  child.unref()
}

/** Start a run of `workflow` for a ticket of the realm at `mainRepo`, working in `cwd` (its main checkout or one of its holdings). */
export function startRun(mainRepo: string, cwd: string, workflow: string, ticket: number, onExit?: (code: number, output: string) => void): void {
  driver(['start', workflow, String(ticket)], cwd, mainRepo, onExit)
}

/** Carry on a run that is resting: after an answer, the human's own step, a usage pause, or a dead driver. */
export function continueRun(run: RunView, onExit?: (code: number, output: string) => void): void {
  driver(['next', run.id], existsSync(run.cwd) ? run.cwd : homedir(), run.mainRepo, onExit)
}

/** End a run: stop its driver (and the agent it is running) if one is alive, then mark the run stopped. */
export function stopRun(run: RunView, onExit?: (code: number, output: string) => void): void {
  try {
    const pid = (JSON.parse(readFileSync(join(runsDir(), `${run.id}.json`), 'utf8')) as { pid?: number }).pid
    if (run.alive && pid) {
      // The driver's agent is its child: on Windows only taskkill /T takes the whole tree.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
      else process.kill(pid)
    }
  } catch {
    /* no state or no process: marking it stopped is all that is left */
  }
  driver(['stop', run.id], homedir(), run.mainRepo, onExit)
}

/**
 * Hand the driver the account's latest quota reading, so unattended runs pause when the 5-hour window is
 * nearly spent even if no agent step has reported one lately. The driver's file keeps seconds, not milliseconds.
 */
export function shareQuota(q: Quota): void {
  const window = (w?: { usedPercent: number; resetsAt: number }) => (w ? { usedPercent: Math.round(w.usedPercent), resetsAt: Math.round(w.resetsAt / 1000) } : undefined)
  try {
    mkdirSync(botalotHome(), { recursive: true })
    writeFileSync(join(botalotHome(), 'quota.json'), JSON.stringify({ fiveHour: window(q.fiveHour), sevenDay: window(q.sevenDay), readAt: new Date().toISOString() }, null, 2))
  } catch (err) {
    console.warn('could not share the quota reading with the driver', err)
  }
}
