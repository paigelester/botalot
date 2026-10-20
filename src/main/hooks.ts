import { createServer, type Server } from 'http'
import { EventEmitter } from 'events'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { configDir } from './config'

export interface HookEvent {
  dragonId: string
  payload: Record<string, unknown>
}

/**
 * Tiny local HTTP server that Claude Code hooks post to.
 * Sessions spawned by the app get DRAGON_PORT and DRAGON_SESSION in their environment,
 * and the hook script (hooks/notify.js) forwards every hook payload here.
 */
export class HookServer extends EventEmitter {
  private server: Server | null = null
  port = 0

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/hook') {
          res.statusCode = 404
          res.end()
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as HookEvent
            if (parsed && typeof parsed.dragonId === 'string') this.emit('event', parsed)
          } catch {
            /* ignore malformed */
          }
          res.statusCode = 204
          res.end()
        })
      })
      this.server.on('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve(this.port)
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}

/**
 * Location of the hook forwarder script shipped with the app. Agent CLIs run it
 * with their own node, which can't read inside app.asar, so packaged builds
 * unpack it (see electron-builder.yml).
 */
export function hookScriptPath(): string {
  const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  return join(root, 'hooks', 'notify.js').replace(/\\/g, '/')
}

/**
 * Writes a settings file passed to `claude --settings` so only sessions started
 * from the app get these hooks. The user's own settings are never touched.
 */
export function writeHookSettings(events: string[]): string {
  return writeSettingsFile(events, 'dragon-hooks.json', '')
}

/**
 * The settings file for background dragons. Their sessions outlive the app and do not inherit its
 * environment, so the hook reads the app's current port from hookPortFile() on every event.
 */
export function writeBackgroundHookSettings(events: string[]): string {
  return writeSettingsFile(events, 'dragon-hooks-background.json', ` --port-file "${hookPortFile().replace(/\\/g, '/')}"`)
}

function writeSettingsFile(events: string[], name: string, extraArgs: string): string {
  const hooks: Record<string, unknown[]> = {}
  for (const ev of events) {
    const hook = { type: 'command', command: `node "${hookScriptPath()}" --event ${ev}${extraArgs}`, timeout: 5 }
    hooks[ev] = [/PreToolUse|PostToolUse|PermissionRequest/.test(ev) ? { matcher: '', hooks: [hook] } : { hooks: [hook] }]
  }
  // The status line input carries the subscription quota, which no hook does. A dragon's status line is
  // the forwarder, which also prints the user's own status line so theirs still shows.
  const own = userStatusLine()
  const chain = own ? ` --chain ${Buffer.from(own, 'utf8').toString('base64')}` : ''
  const statusLine = { type: 'command', command: `node "${hookScriptPath()}" --event StatusLine${extraArgs}${chain}`, padding: 0 }
  const settings = { hooks, statusLine }
  const path = join(configDir(), name)
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  return path
}

/**
 * The status line command from the user's own Claude Code settings, if any. Read when the app starts,
 * so a change to it reaches dragons after a restart.
 */
function userStatusLine(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { statusLine?: { type?: string; command?: unknown } }
    const sl = settings.statusLine
    return sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim() ? sl.command : null
  } catch {
    return null
  }
}

/**
 * A copy of a settings file with permission rules added, for dragons that work unattended. Written as
 * `name` in the config folder and rewritten on every call, so the latest rules apply to the next dragon.
 */
export function withPermissions(basePath: string, name: string, permissions: object): string {
  const settings = JSON.parse(readFileSync(basePath, 'utf8')) as Record<string, unknown>
  settings.permissions = permissions
  const path = join(configDir(), name)
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  return path
}

/** Holds the hook server's port while the app runs; removed on quit so stale hooks post nowhere. */
export function hookPortFile(): string {
  return join(configDir(), 'hook-port')
}

export function writeHookPortFile(port: number): void {
  try {
    writeFileSync(hookPortFile(), String(port), 'utf8')
  } catch (err) {
    console.warn('could not write hook port file', err)
  }
}

export function removeHookPortFile(): void {
  rmSync(hookPortFile(), { force: true })
}
