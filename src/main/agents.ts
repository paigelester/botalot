import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { AgentKind } from '@shared/types'
import { writeBackgroundHookSettings, writeHookSettings } from './hooks'

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

/** The hook events the app listens to. Elicitation fires when an MCP tool asks the user a question. */
const CLAUDE_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest', 'Notification', 'Elicitation']

export interface AgentDef {
  id: AgentKind
  label: string
  binary: string
  /** Environment variable that overrides the binary (demo mode and tests). */
  override: string
  /** Build the argv for a new interactive session. */
  args(opts: { prompt?: string; hookSettingsPath: string }): string[]
  /** Argv to resume an earlier session. agentSessionId is the agent's own id when known. */
  resumeArgs(opts: { agentSessionId?: string; hookSettingsPath: string }): string[]
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
      agentSessionId ? ['--settings', hookSettingsPath, '--resume', agentSessionId] : ['--settings', hookSettingsPath, '--continue']
  }
}

/** Claude's hook settings file, with the event name passed as an argument so payloads are self-describing. */
export function ensureClaudeHooks(): string {
  return writeHookSettings(CLAUDE_EVENTS)
}

/** Claude's hook settings for background dragons, which find the app through the port file. */
export function ensureClaudeBackgroundHooks(): string {
  return writeBackgroundHookSettings(CLAUDE_EVENTS)
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
