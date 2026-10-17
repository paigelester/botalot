import { createServer, type Server } from 'http'
import { EventEmitter } from 'events'
import { writeFileSync } from 'fs'
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

/** Location of the hook forwarder script shipped with the app. */
export function hookScriptPath(): string {
  return join(app.getAppPath(), 'hooks', 'notify.js').replace(/\\/g, '/')
}

/**
 * Writes a settings file passed to `claude --settings` so only sessions started
 * from the app get these hooks. The user's own settings are never touched.
 */
export function writeHookSettings(events: string[]): string {
  const hooks: Record<string, unknown[]> = {}
  for (const ev of events) {
    const hook = { type: 'command', command: `node "${hookScriptPath()}" --event ${ev}`, timeout: 5 }
    hooks[ev] = [/PreToolUse|PostToolUse|PermissionRequest/.test(ev) ? { matcher: '', hooks: [hook] } : { hooks: [hook] }]
  }
  const settings = { hooks }
  const path = join(configDir(), 'dragon-hooks.json')
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
  return path
}
