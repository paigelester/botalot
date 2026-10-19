import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentInfo, AgentKind } from '@shared/types'
import { hookScriptPath, writeHookSettings } from './hooks'

/** node-pty on Windows needs a full executable path, so resolve bare names through where.exe. */
export function resolveOnPath(name: string): string | null {
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null
  const win = process.platform === 'win32'
  try {
    const out = execFileSync(win ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true })
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    // Prefer a real executable. An npm .cmd shim cannot be spawned by ConPTY directly, so unwrap it to its JS entry.
    const exe = lines.find((l) => !win || /\.exe$/i.test(l))
    if (exe) return exe
    const shim = lines.find((l) => /\.cmd$/i.test(l))
    if (shim) return unwrapNpmShim(shim) ?? shim
    return lines[0] ?? null
  } catch {
    return null
  }
}

/** npm's Windows .cmd shims run `node "<dp0>\node_modules\...\entry.js"`; return that entry so we can run it with node ourselves. */
function unwrapNpmShim(cmdPath: string): string | null {
  try {
    const text = readFileSync(cmdPath, 'utf8')
    const m = /"%dp0%\\(node_modules\\[^"]+\.c?js)"/i.exec(text)
    if (!m) return null
    const entry = join(cmdPath, '..', m[1])
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

/** Events both agents understand, in the PascalCase spelling they share. */
const COMMON_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest', 'Notification']
/** Claude Code only: Elicitation fires when an MCP tool asks the user a question. */
const CLAUDE_EVENTS = [...COMMON_EVENTS, 'Elicitation']
/** Copilot CLI only: ErrorOccurred. Its notification event exists only in camelCase and is added separately. */
const COPILOT_EVENTS = [...COMMON_EVENTS.filter((e) => e !== 'Notification'), 'ErrorOccurred']

export interface AgentDef {
  id: AgentKind
  label: string
  binary: string
  /** Environment variable that overrides the binary (demo mode and tests). */
  override: string
  /** Build the argv for a new interactive session. */
  args(opts: { prompt?: string; sessionId: string; name: string; hookSettingsPath: string }): string[]
  /** Argv to resume an earlier session. agentSessionId is the agent's own id when known. */
  resumeArgs(opts: { sessionId: string; agentSessionId?: string; name: string; hookSettingsPath: string }): string[]
  /** Setup before a session starts in `cwd`: hook wiring, folder trust, and so on. */
  prepare(cwd: string): Promise<string | undefined>
  note?: string
}

export const AGENTS: Record<AgentKind, AgentDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    override: 'DRAGON_CLAUDE_BIN',
    args: ({ prompt, hookSettingsPath }) => {
      const a = ['--settings', hookSettingsPath]
      if (prompt) a.push(prompt)
      return a
    },
    resumeArgs: ({ agentSessionId, hookSettingsPath }) =>
      agentSessionId ? ['--settings', hookSettingsPath, '--resume', agentSessionId] : ['--settings', hookSettingsPath, '--continue'],
    prepare: async () => undefined,
    note: 'Hooks are injected per session with --settings; your own settings are untouched.'
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    binary: 'copilot',
    override: 'DRAGON_COPILOT_BIN',
    args: ({ prompt, sessionId, name }) => {
      const a = ['--session-id', sessionId, '-n', name]
      if (prompt) a.push('-i', prompt)
      return a
    },
    resumeArgs: ({ sessionId, agentSessionId }) => ['--resume', agentSessionId || sessionId],
    prepare: async (cwd) => {
      trustFolderForCopilot(cwd)
      return ensureCopilotHooks()
    },
    note: 'Needs the Copilot CLI (npm i -g @github/copilot). The app writes one user-level hooks file and marks the realm folder as trusted.'
  }
}

export function copilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), '.copilot')
}

/**
 * Copilot CLI asks "Do you trust the files in this folder?" before any hook fires.
 * Summoning a dragon into a realm is that answer, so record the folder in config.json up front.
 */
export function trustFolderForCopilot(cwd: string): void {
  const file = join(copilotHome(), 'config.json')
  try {
    // The file starts with // comment lines that Copilot writes; keep them and parse the rest.
    let header = ''
    let cfg: Record<string, unknown> = {}
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      const headerLines: string[] = []
      while (lines.length && /^\s*\/\//.test(lines[0])) headerLines.push(lines.shift()!)
      header = headerLines.length ? headerLines.join('\n') + '\n' : ''
      const body = lines.join('\n').trim()
      cfg = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    }
    const list = Array.isArray(cfg.trustedFolders) ? (cfg.trustedFolders as string[]) : []
    const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    if (list.some((p) => norm(p) === norm(cwd))) return
    cfg.trustedFolders = [...list, cwd]
    mkdirSync(copilotHome(), { recursive: true })
    writeFileSync(file, header + JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.warn('could not update Copilot trusted folders', err)
  }
}

/**
 * Copilot CLI has no per-session settings flag, so hooks go in the user-level hooks folder.
 * They are inert outside the app: notify.js exits immediately when DRAGON_PORT is not set.
 */
export async function ensureCopilotHooks(): Promise<string | undefined> {
  const node = resolveOnPath('node') ?? 'node'
  const script = hookScriptPath()
  const hooks: Record<string, unknown[]> = {}
  for (const ev of COPILOT_EVENTS) hooks[ev] = [{ type: 'command', exec: node, args: [script, '--event', ev], timeoutSec: 5 }]
  // Notifications only exist in the camelCase spelling.
  hooks.notification = [{ type: 'command', exec: node, args: [script, '--event', 'Notification'], timeoutSec: 5 }]
  const content = JSON.stringify({ version: 1, hooks }, null, 2) + '\n'
  const dir = join(copilotHome(), 'hooks')
  const file = join(dir, 'botalot.json')
  try {
    // The app used to be called Dragon Kingdom; retire its hooks file so events are not delivered twice.
    const old = join(dir, 'dragon-kingdom.json')
    if (existsSync(old)) rmSync(old, { force: true })
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return file
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content, 'utf8')
    return file
  } catch (err) {
    console.warn('could not write Copilot hooks file', err)
    return undefined
  }
}

/** Claude's hook settings file, with the event name passed as an argument so payloads are self-describing. */
export function ensureClaudeHooks(): string {
  return writeHookSettings(CLAUDE_EVENTS)
}

/**
 * The environment for an agent process the app starts. If the app itself was launched from inside a
 * Claude Code session, children would inherit nesting markers and run as throwaway child sessions
 * (no transcript, so no resume), so those are stripped.
 */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  return env
}

export function listAgents(): AgentInfo[] {
  return (Object.values(AGENTS) as AgentDef[]).map((a) => ({
    id: a.id,
    label: a.label,
    path: process.env[a.override] || resolveOnPath(a.binary),
    note: a.note
  }))
}
