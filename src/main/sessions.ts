import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { UNCLAIMED_REALM, type AgentKind, type Project, type Session, type SessionState, type SpawnRequest } from '@shared/types'
import { addWorktree, currentBranch, gitInfo, listWorktrees } from './git'
import { randomName } from './names'
import type { HookEvent } from './hooks'
import type { RegistryEntry } from './registry'
import type { BackgroundEntry } from './background'
import { normalizePath } from './projects'
import { AGENTS, childEnv, resolveOnPath } from './agents'
import { loadSessionRecords, saveSessionRecords, type SessionRecord } from './sessionStore'

const SCROLLBACK_LIMIT = 400_000 // characters kept per session for replay when a panel opens
const HOOK_AUTHORITY_MS = 4000 // after a hook event, ignore the registry for this long
const OUTPUT_IDLE_MS = 3000 // without hooks, this much terminal silence after output means idle

interface LiveSession {
  session: Session
  proc: pty.IPty | null
  scrollback: string
  lastHookAt: number
  gitTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
}

/** Strip ANSI escapes so prompt text can be pattern-matched. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}

const PERMISSION_PATTERNS =
  /\b(allow|approve|permission|confirm|proceed|trust)\b[^\n]*\?|do you (want|trust|allow)|\(y\/n\)|\[y\/N\]|\[Y\/n\]|yes\/no|enter to select/i

export class SessionManager extends EventEmitter {
  private live = new Map<string, LiveSession>()

  constructor(
    private hookPort: number,
    private hookSettingsPath: string
  ) {
    super()
  }

  // ------------------------------------------------------------------ records

  private toRecord(s: Session): SessionRecord {
    return {
      id: s.id,
      name: s.name,
      agent: s.agent,
      projectId: s.projectId,
      cwd: s.cwd,
      branch: s.branch,
      isWorktree: s.isWorktree,
      startedAt: s.startedAt,
      agentSessionId: s.claudeSessionId,
      lastSeenAt: Date.now()
    }
  }

  /** Persist every dragon we know about. Called on creation and on every meaningful change. */
  private persist(): void {
    if (process.env.DRAGON_DEMO) return // fake dragons are never remembered
    // Wild dragons belong to Claude Code's own supervisor; the poller rediscovers them on every launch.
    const owned = [...this.live.values()].filter((l) => !l.session.wildId)
    saveSessionRecords(owned.map((l) => this.toRecord(l.session)))
  }

  /** Bring back dragons recorded by earlier runs as dormant, ready to be woken. */
  restore(getProject: (id: string) => Project | undefined): void {
    for (const r of loadSessionRecords()) {
      if (this.live.has(r.id)) continue
      const folderExists = existsSync(r.cwd)
      const session: Session = {
        id: r.id,
        name: r.name,
        agent: r.agent,
        projectId: r.projectId,
        cwd: r.cwd,
        branch: r.branch,
        isWorktree: r.isWorktree,
        state: folderExists ? 'dormant' : 'dead',
        stateSince: Date.now(),
        startedAt: r.startedAt,
        claudeSessionId: r.agentSessionId,
        attention: folderExists ? (getProject(r.projectId) ? undefined : 'Its realm is gone; bury it') : 'Holding folder is gone',
        resumable: folderExists && !!getProject(r.projectId)
      }
      this.live.set(r.id, { session, proc: null, scrollback: '', lastHookAt: 0, gitTimer: null, idleTimer: null })
    }
  }

  list(): Session[] {
    return [...this.live.values()].map((l) => l.session)
  }

  get(id: string): Session | undefined {
    return this.live.get(id)?.session
  }

  scrollback(id: string): string {
    return this.live.get(id)?.scrollback ?? ''
  }

  private takenNames(): Set<string> {
    return new Set(this.list().map((s) => s.name))
  }

  randomName(): string {
    return randomName(this.takenNames())
  }

  private setState(l: LiveSession, state: SessionState, attention?: string): void {
    if (l.session.state === 'dead' || l.session.state === 'dormant') return
    if (l.session.state !== state) {
      l.session.state = state
      l.session.stateSince = Date.now()
    }
    l.session.attention = attention
  }

  private publish(l: LiveSession): void {
    this.emit('update', { ...l.session })
  }

  private resolveBinary(agent: AgentKind): string | null {
    const def = AGENTS[agent]
    const override = process.env[def.override]
    if (override) return override
    return resolveOnPath(def.binary)
  }

  // -------------------------------------------------------------------- spawn

  async spawn(req: SpawnRequest, project: Project): Promise<Session> {
    const agent: AgentKind = req.agent ?? 'claude'
    const def = AGENTS[agent]
    const binary = this.resolveBinary(agent)
    if (!binary) throw new Error(`${def.label} is not installed (no "${def.binary}" on PATH).`)

    let cwd = project.path
    let branch = ''
    let isWorktree = false
    let baseNote: string | undefined
    if (req.target.kind === 'new') {
      const wt = await addWorktree(project.path, req.target.branch, project.worktreeLayout, req.target.folder)
      cwd = wt.path
      branch = wt.branch
      isWorktree = true
      if (wt.base) baseNote = wt.base.fromRemote ? 'Branched from latest ' + wt.base.startPoint : wt.base.note
    } else if (req.target.kind === 'existing') {
      cwd = req.target.path
      const trees = await listWorktrees(project.path)
      const match = trees.find((t) => normalizePath(t.path) === normalizePath(cwd))
      branch = match?.branch ?? (await currentBranch(cwd))
      isWorktree = !(match?.isMain ?? false)
    } else {
      branch = await currentBranch(cwd)
    }

    await def.prepare(cwd)

    const id = randomUUID()
    const name = req.name?.trim() || this.randomName()
    const prompt = req.prompt?.trim() || undefined
    const session: Session = {
      id,
      name,
      agent,
      projectId: project.id,
      cwd,
      branch,
      isWorktree,
      state: prompt ? 'working' : 'idle',
      stateSince: Date.now(),
      attention: baseNote,
      startedAt: Date.now()
    }
    const l: LiveSession = { session, proc: null, scrollback: '', lastHookAt: 0, gitTimer: null, idleTimer: null }
    this.live.set(id, l)
    // Recorded at birth, so a crash or restart never loses it.
    this.persist()

    const args = def.args({ prompt, sessionId: id, name, hookSettingsPath: this.hookSettingsPath })
    this.launch(l, binary, args)
    return { ...session }
  }

  /** Resume a dormant or dead dragon in its folder. Keeps the same dragon id and name. */
  async wake(id: string, getProject: (id: string) => Project | undefined): Promise<Session> {
    const l = this.live.get(id)
    if (!l) throw new Error('No such dragon')
    const s = l.session
    if (l.proc) return { ...s }
    if (!existsSync(s.cwd)) throw new Error(`Its folder is gone: ${s.cwd}`)
    const project = getProject(s.projectId)
    if (!project) throw new Error('Its realm has been removed. Bury this dragon or add the realm back.')
    const def = AGENTS[s.agent]
    const binary = this.resolveBinary(s.agent)
    if (!binary) throw new Error(`${def.label} is not installed (no "${def.binary}" on PATH).`)
    await def.prepare(s.cwd)

    s.state = 'idle'
    s.stateSince = Date.now()
    s.exitCode = undefined
    s.resumable = undefined
    s.attention = s.claudeSessionId || s.agent === 'copilot' ? 'Woken: resuming its earlier session' : 'Woken: continuing the most recent session in this folder'
    l.scrollback = ''
    l.lastHookAt = 0

    const args = def.resumeArgs({ sessionId: s.id, agentSessionId: s.claudeSessionId, name: s.name, hookSettingsPath: this.hookSettingsPath })
    this.launch(l, binary, args)
    return { ...s }
  }

  /** Start the agent process for a session and wire up output, exit, and git polling. */
  private launch(l: LiveSession, binary: string, args: string[]): void {
    const session = l.session
    const def = AGENTS[session.agent]
    // A .js/.cjs binary (used by the demo mode and tests, and npm shims) is run through node.
    let file = binary
    if (/\.c?js$/i.test(file)) {
      args = [file, ...args]
      file = resolveOnPath('node') ?? 'node'
    }

    const env = childEnv()
    env.DRAGON_SESSION = session.id
    env.DRAGON_PORT = String(this.hookPort)
    env.DRAGON_AGENT = session.agent
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // Do not pretend to be the terminal the app was launched from, or agents offer to edit its settings.
    delete env.WT_SESSION
    delete env.WT_PROFILE_ID
    delete env.TERM_PROGRAM_VERSION
    env.TERM_PROGRAM = 'botalot'

    try {
      l.proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: session.cwd,
        env,
        useConpty: true
      })
    } catch (err) {
      session.state = 'dead'
      session.resumable = true
      session.attention = `Failed to start ${def.label}: ${(err as Error).message}`
      this.publish(l)
      return
    }
    session.pid = l.proc.pid

    l.proc.onData((data) => {
      l.scrollback += data
      if (l.scrollback.length > SCROLLBACK_LIMIT) l.scrollback = l.scrollback.slice(-SCROLLBACK_LIMIT)
      this.emit('data', session.id, data)
      this.observeOutput(l, data)
    })
    l.proc.onExit(({ exitCode }) => {
      session.exitCode = exitCode
      session.state = 'dead'
      session.stateSince = Date.now()
      session.resumable = existsSync(session.cwd)
      session.attention = exitCode === 0 ? 'Session ended. Wake it to resume.' : `Exited with code ${exitCode}. Wake it to resume.`
      if (l.gitTimer) clearInterval(l.gitTimer)
      if (l.idleTimer) clearTimeout(l.idleTimer)
      l.gitTimer = null
      l.proc = null
      this.publish(l)
    })

    if (l.gitTimer) clearInterval(l.gitTimer)
    l.gitTimer = setInterval(() => void this.refreshGit(session.id), 15_000)
    void this.refreshGit(session.id)
    this.publish(l)
  }

  /**
   * Fallback state detection from terminal output, used only while no hook has ever
   * reported for the session (for example an agent whose hooks are not configured).
   */
  private observeOutput(l: LiveSession, data: string): void {
    if (l.lastHookAt !== 0 || l.session.state === 'dead') return
    const text = plain(data)
    if (text.trim().length === 0) return
    const tail = plain(l.scrollback.slice(-600))
    if (PERMISSION_PATTERNS.test(tail)) {
      if (l.session.state !== 'waiting') {
        this.setState(l, 'waiting', 'Seems to be asking for permission')
        this.publish(l)
      }
    } else if (l.session.state !== 'working' && Date.now() - l.session.stateSince > 1500) {
      this.setState(l, 'working')
      this.publish(l)
    }
    if (l.idleTimer) clearTimeout(l.idleTimer)
    l.idleTimer = setTimeout(() => {
      if (l.lastHookAt === 0 && l.session.state === 'working') {
        this.setState(l, 'idle')
        this.publish(l)
      }
    }, OUTPUT_IDLE_MS)
  }

  async refreshGit(id: string): Promise<Session | undefined> {
    const l = this.live.get(id)
    if (!l) return undefined
    const info = await gitInfo(l.session.cwd)
    if (info) {
      l.session.git = info
      if (info.branch && info.branch !== l.session.branch) {
        l.session.branch = info.branch
        this.persist()
      }
      this.publish(l)
    }
    return { ...l.session }
  }

  write(id: string, data: string): void {
    this.live.get(id)?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.live.get(id)?.proc
    if (p && cols > 0 && rows > 0) {
      try {
        p.resize(cols, rows)
      } catch {
        /* resizing an exited pty throws */
      }
    }
  }

  kill(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    if (l.proc) {
      try {
        l.proc.kill()
      } catch {
        /* already gone */
      }
    } else if (l.session.state !== 'dead') {
      l.session.state = 'dead'
      l.session.stateSince = Date.now()
      l.session.resumable = existsSync(l.session.cwd)
      this.publish(l)
    }
  }

  /** Remove a dragon from the kingdom and forget its record. */
  dismiss(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    if (l.proc) this.kill(id)
    if (l.gitTimer) clearInterval(l.gitTimer)
    if (l.idleTimer) clearTimeout(l.idleTimer)
    this.live.delete(id)
    this.persist()
    this.emit('removed', id)
  }

  /** On quit: stop the processes but keep every record, so the dragons come back dormant. */
  killAll(): void {
    this.persist()
    for (const l of this.live.values()) {
      if (l.proc) {
        try {
          l.proc.kill()
        } catch {
          /* already gone */
        }
      }
    }
  }

  /**
   * Apply a hook event forwarded by hooks/notify.js. Claude Code sends snake_case payloads;
   * Copilot CLI sends snake_case for PascalCase-configured events and camelCase for the rest,
   * so both spellings are read.
   */
  handleHook(ev: HookEvent): void {
    const l = this.live.get(ev.dragonId)
    if (!l) return
    const p = ev.payload
    const str = (...keys: string[]): string => {
      for (const k of keys) if (typeof p[k] === 'string' && p[k]) return p[k] as string
      return ''
    }
    const event = str('hook_event_name')
    l.lastHookAt = Date.now()
    if (l.idleTimer) {
      clearTimeout(l.idleTimer)
      l.idleTimer = null
    }
    l.session.lastEvent = event
    const sid = str('session_id', 'sessionId')
    if (sid && sid !== l.session.claudeSessionId) {
      l.session.claudeSessionId = sid
      this.persist()
    }
    const tool = str('tool_name', 'toolName')

    switch (event) {
      case 'SessionStart':
        break
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.setState(l, 'working')
        break
      case 'PreToolUse': {
        if (tool === 'AskUserQuestion' || tool === 'ask_user') this.setState(l, 'waiting', 'Asking you a question')
        else this.setState(l, 'working', tool ? `Using ${tool}` : undefined)
        break
      }
      case 'PermissionRequest':
        this.setState(l, 'waiting', tool ? `Needs your permission to use ${tool}` : 'Needs your permission')
        break
      case 'Elicitation':
        this.setState(l, 'waiting', 'A tool is asking you a question')
        break
      case 'Notification': {
        const type = str('notification_type', 'notificationType')
        const msg = str('message')
        if (type === 'permission_prompt' || /permission/i.test(msg)) {
          this.setState(l, 'waiting', msg || 'Needs your permission')
        } else if (type === 'idle_prompt' || /waiting for (your )?input/i.test(msg)) {
          this.setState(l, 'idle', msg || undefined)
        } else if (type === 'elicitation_dialog') {
          this.setState(l, 'waiting', msg || 'Needs your input')
        } else if (msg) {
          l.session.attention = msg
        }
        break
      }
      case 'ErrorOccurred': {
        const e = p.error as { message?: string } | string | undefined
        const msg = typeof e === 'string' ? e : (e?.message ?? 'Error')
        l.session.attention = `Error: ${msg}`
        break
      }
      case 'Stop':
        this.setState(l, 'idle')
        void this.refreshGit(ev.dragonId)
        break
      case 'SessionEnd':
        this.setState(l, 'idle', 'Session ending')
        break
      default:
        break
    }
    this.publish(l)
  }

  /** Baseline state from Claude Code's live session registry, used when hooks are quiet. */
  applyRegistry(entries: RegistryEntry[]): void {
    const claimed = new Set<number>()
    for (const l of this.live.values()) {
      if (l.session.wildId || l.session.state === 'dead' || l.session.state === 'dormant' || l.session.agent !== 'claude' || !l.proc) continue
      let entry: RegistryEntry | undefined
      if (l.session.claudeSessionId) entry = entries.find((e) => e.sessionId === l.session.claudeSessionId)
      if (!entry) {
        const since = l.session.startedAt - 2000
        entry = entries.find((e) => {
          if (claimed.has(e.pid)) return false
          if (!e.cwd || normalizePath(e.cwd) !== normalizePath(l.session.cwd)) return false
          const started = typeof e.startedAt === 'string' ? Date.parse(e.startedAt) : Number(e.startedAt ?? 0)
          return started >= since
        })
      }
      if (!entry) continue
      claimed.add(entry.pid)
      if (entry.sessionId && !l.session.claudeSessionId) {
        l.session.claudeSessionId = entry.sessionId
        this.persist()
      }
      const quiet = Date.now() - l.lastHookAt > HOOK_AUTHORITY_MS
      if (!quiet || l.session.state === 'waiting') continue
      const status = String(entry.status ?? '').toLowerCase()
      const next: SessionState = status === 'busy' || status === 'working' ? 'working' : 'idle'
      if (next !== l.session.state) {
        this.setState(l, next, next === 'idle' ? undefined : l.session.attention)
        this.publish(l)
      }
    }
  }

  // ------------------------------------------------------------ wild dragons

  /**
   * Mirror Claude Code's background sessions (from `claude agents --json --all`) as wild dragons.
   * Each poll is the full truth: wild dragons missing from it leave the kingdom.
   */
  applyBackground(entries: BackgroundEntry[], projects: Project[]): void {
    const ownedSessionIds = new Set<string>()
    for (const l of this.live.values()) if (!l.session.wildId && l.session.claudeSessionId) ownedSessionIds.add(l.session.claudeSessionId)

    const seen = new Set<string>()
    for (const e of entries) {
      if (e.sessionId && ownedSessionIds.has(e.sessionId)) continue
      const id = 'wild-' + e.id
      seen.add(id)
      const realm = realmFor(e.cwd, projects)
      const { state, attention } = wildState(e)
      let l = this.live.get(id)
      if (!l) {
        const session: Session = {
          id,
          name: e.name || e.id,
          agent: 'claude',
          projectId: realm?.id ?? UNCLAIMED_REALM,
          cwd: e.cwd,
          branch: '',
          isWorktree: !!realm && normalizePath(realm.path) !== normalizePath(e.cwd),
          state,
          stateSince: Date.now(),
          attention,
          claudeSessionId: e.sessionId,
          wildId: e.id,
          pid: e.pid,
          startedAt: e.startedAt ?? Date.now()
        }
        l = { session, proc: null, scrollback: '', lastHookAt: 0, gitTimer: null, idleTimer: null }
        this.live.set(id, l)
        const live = l
        live.gitTimer = setInterval(() => void this.refreshGit(id), 15_000)
        void this.refreshGit(id)
        this.publish(live)
        continue
      }
      const s = l.session
      const projectId = realm?.id ?? UNCLAIMED_REALM
      const isWorktree = !!realm && normalizePath(realm.path) !== normalizePath(e.cwd)
      const changed =
        s.state !== state || s.attention !== attention || s.projectId !== projectId || s.cwd !== e.cwd || s.isWorktree !== isWorktree || s.pid !== e.pid || s.name !== (e.name || e.id)
      if (!changed) continue
      // Set directly rather than through setState: a wild dragon may come back from failed or stopped.
      if (s.state !== state) {
        s.state = state
        s.stateSince = Date.now()
      }
      s.attention = attention
      s.projectId = projectId
      s.cwd = e.cwd
      s.isWorktree = isWorktree
      s.pid = e.pid
      s.name = e.name || e.id
      this.publish(l)
    }

    for (const [id, l] of this.live) if (l.session.wildId && !seen.has(id)) this.dismiss(id)
  }

  /** Open `claude attach <id>` in a pty for a wild dragon. Its output streams like any dragon's terminal. */
  attach(id: string): void {
    const l = this.live.get(id)
    if (!l || !l.session.wildId || l.proc) return
    const binary = this.resolveBinary('claude')
    if (!binary) {
      l.scrollback = 'Claude Code is not installed (no "claude" on PATH).\r\n'
      this.emit('data', id, l.scrollback)
      return
    }
    let file = binary
    let args = ['attach', l.session.wildId]
    if (/\.c?js$/i.test(file)) {
      args = [file, ...args]
      file = resolveOnPath('node') ?? 'node'
    }
    const env = childEnv()
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'botalot'
    l.scrollback = ''
    let proc: pty.IPty
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: existsSync(l.session.cwd) ? l.session.cwd : homedir(),
        env,
        useConpty: true
      })
    } catch (err) {
      const msg = `Could not attach: ${(err as Error).message}\r\n`
      l.scrollback = msg
      this.emit('data', id, msg)
      return
    }
    l.proc = proc
    proc.onData((data) => {
      l.scrollback += data
      if (l.scrollback.length > SCROLLBACK_LIMIT) l.scrollback = l.scrollback.slice(-SCROLLBACK_LIMIT)
      this.emit('data', id, data)
    })
    // The attach client ending (Ctrl+Z, or the session going away) leaves the background session alone.
    proc.onExit(() => {
      if (l.proc !== proc) return
      l.proc = null
      const note = '\r\n\x1b[2m[detached; close and reopen the panel to attach again]\x1b[0m\r\n'
      l.scrollback += note
      this.emit('data', id, note)
    })
  }

  /** Close a wild dragon's attach client. The background session keeps running under Claude Code. */
  detach(id: string): void {
    const l = this.live.get(id)
    if (!l || !l.session.wildId) return
    const proc = l.proc
    l.proc = null
    l.scrollback = ''
    if (!proc) return
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
}

/** The realm whose folder holds `cwd`. The deepest match wins, so nested realms claim their own sessions. */
function realmFor(cwd: string, projects: Project[]): Project | undefined {
  const target = normalizePath(cwd)
  let best: Project | undefined
  for (const p of projects) {
    const root = normalizePath(p.path)
    if (target !== root && !target.startsWith(root + '\\')) continue
    if (!best || root.length > normalizePath(best.path).length) best = p
  }
  return best
}

/** Map a background session's state and status onto a dragon state. */
function wildState(e: BackgroundEntry): { state: SessionState; attention?: string } {
  const state = String(e.state ?? '').toLowerCase()
  const status = String(e.status ?? '').toLowerCase()
  if (state === 'blocked' || status === 'waiting') return { state: 'waiting', attention: describeWaitingFor(e.waitingFor) }
  if (state === 'failed') return { state: 'dead', attention: 'The background session failed' }
  if (state === 'stopped') return { state: 'dead', attention: 'Stopped by Claude Code; its transcript is kept' }
  if (state === 'working' || status === 'busy') return { state: 'working' }
  return { state: 'idle', attention: state === 'done' ? 'Finished its task' : undefined }
}

/** `waitingFor` is free-form in the CLI: a string such as "permission prompt", or an object with a type or message. */
function describeWaitingFor(w: unknown): string {
  let text = ''
  if (typeof w === 'string') text = w
  else if (w && typeof w === 'object') {
    const o = w as Record<string, unknown>
    for (const k of ['message', 'description', 'type', 'kind']) {
      if (typeof o[k] === 'string' && o[k]) {
        text = o[k] as string
        break
      }
    }
  }
  text = text.replace(/[_-]+/g, ' ').trim()
  return text ? 'Waiting for ' + text : 'Waiting for you'
}
