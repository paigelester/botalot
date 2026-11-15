import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { UNCLAIMED_REALM, type AgentKind, type Project, type PullRequestInfo, type Session, type SessionState, type SpawnRequest } from '@shared/types'
import { addWorktree, currentBranch, gitInfo, listWorktrees } from './git'
import { randomName } from './names'
import type { HookEvent } from './hooks'
import type { RegistryEntry } from './registry'
import type { BackgroundEntry } from './background'
import { normalizePath } from './projects'
import { AGENTS, childEnv, resolveOnPath } from './agents'
import { loadSessionRecords, saveSessionRecords, type SessionRecord } from './sessionStore'
import { stuckThresholds, type StuckThresholds } from './config'

const SCROLLBACK_LIMIT = 400_000 // characters kept per session for replay when a panel opens
const HOOK_AUTHORITY_MS = 4000 // after a hook event, ignore the registry for this long
const OUTPUT_IDLE_MS = 3000 // without hooks, this much terminal silence after output means idle
const STUCK_CHECK_MS = 10_000 // how often quiet dragons are re-examined; hooks and state changes check at once

interface LiveSession {
  session: Session
  proc: pty.IPty | null
  scrollback: string
  lastHookAt: number
  /** Last terminal output; the activity signal for dragons that never send hooks. */
  lastOutputAt?: number
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
    private hookSettingsPath: string,
    private backgroundHookSettingsPath: string
  ) {
    super()
    this.stuckTimer = setInterval(() => {
      this.thresholds = stuckThresholds()
      for (const l of this.live.values()) if (this.updateStuck(l)) this.emit('update', { ...l.session })
    }, STUCK_CHECK_MS)
  }

  private thresholds: StuckThresholds = stuckThresholds()
  private stuckTimer: NodeJS.Timeout

  /**
   * Work out whether a dragon looks stuck: working with no activity, or waiting on you, for too long.
   * Stuck is a reason string beside the state, never a state of its own. Returns true when it changed.
   */
  private updateStuck(l: LiveSession): boolean {
    const s = l.session
    const now = Date.now()
    const min = 60_000
    let reason: string | undefined
    if (s.state === 'waiting' && now - s.stateSince > this.thresholds.waitingMinutes * min) {
      reason = `Waiting on you for ${duration(now - s.stateSince)}`
    } else if (s.state === 'working' && !s.wild) {
      // Wild dragons send no hooks and have no terminal here, so there is nothing to measure activity by.
      const activity = l.lastHookAt || l.lastOutputAt || 0
      const quietSince = Math.max(activity, s.stateSince)
      if (now - quietSince > this.thresholds.workingQuietMinutes * min) reason = `No activity for ${duration(now - quietSince)}`
    }
    if (reason === s.stuck) return false
    s.stuck = reason
    return true
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
      backgroundId: s.backgroundId,
      lastSeenAt: Date.now()
    }
  }

  /** Persist every dragon we know about. Called on creation and on every meaningful change. */
  private persist(): void {
    if (process.env.DRAGON_DEMO) return // fake dragons are never remembered
    // Wild dragons belong to Claude Code's own supervisor; the poller rediscovers them on every launch.
    const owned = [...this.live.values()].filter((l) => !l.session.wild)
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
        backgroundId: r.backgroundId,
        attention: folderExists ? (getProject(r.projectId) ? undefined : 'Its realm is gone; bury it') : 'Holding folder is gone',
        resumable: folderExists && !!getProject(r.projectId)
      }
      // A background dragon may still be running: the first poll brings it back to life, or marks it fallen.
      if (r.backgroundId && folderExists) session.attention = 'Looking for its background session…'
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
    this.updateStuck(l)
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
    if (req.background && !req.prompt?.trim()) throw new Error('A background dragon needs a first quest: there is no terminal to type it in.')

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
    // A resumed session is already known by its agent id, so hooks and a later wake find it.
    if (req.resume) session.claudeSessionId = req.resume
    if (req.background) {
      // Dispatched before the dragon exists: if Claude Code refuses (untrusted folder, say), nothing is left behind.
      const out = await runClaude(binary, ['--bg', '--name', name, '--settings', this.backgroundHookSettingsPath, prompt!], cwd)
      const m = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(plain(out))
      if (!m) throw new Error('Claude Code did not start a background session: ' + (plain(out).trim().split(/\r?\n/)[0] || 'no output'))
      session.backgroundId = m[1]
    }
    const l: LiveSession = { session, proc: null, scrollback: '', lastHookAt: 0, gitTimer: null, idleTimer: null }
    this.live.set(id, l)
    // Recorded at birth, so a crash or restart never loses it.
    this.persist()

    if (session.backgroundId) {
      this.startGitPolling(l)
      this.publish(l)
      return { ...session }
    }
    const args = req.resume ? def.resumeArgs({ agentSessionId: req.resume, hookSettingsPath: this.hookSettingsPath }) : def.args({ prompt, hookSettingsPath: this.hookSettingsPath })
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

    s.state = 'idle'
    s.stateSince = Date.now()
    s.exitCode = undefined
    // A background dragon whose session is gone is woken in the app's own pty from here on.
    if (s.backgroundId) {
      s.backgroundId = undefined
      this.persist()
    }
    s.resumable = undefined
    s.attention = s.claudeSessionId ? 'Woken: resuming its earlier session' : 'Woken: continuing the most recent session in this folder'
    l.scrollback = ''
    l.lastHookAt = 0

    const args = def.resumeArgs({ agentSessionId: s.claudeSessionId, hookSettingsPath: this.hookSettingsPath })
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
      l.lastOutputAt = Date.now()
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

    this.startGitPolling(l)
    this.publish(l)
  }

  private startGitPolling(l: LiveSession): void {
    if (l.gitTimer) clearInterval(l.gitTimer)
    l.gitTimer = setInterval(() => void this.refreshGit(l.session.id), 15_000)
    void this.refreshGit(l.session.id)
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

  /** Attach the pull request for the dragon's branch (from PrWatcher). Not recorded: it is looked up again on launch. */
  setPr(id: string, pr: PullRequestInfo | undefined): void {
    const l = this.live.get(id)
    if (!l) return
    l.session.pr = pr
    this.publish(l)
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

  async kill(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    if (l.session.wild) return // not ours to slay
    if (l.session.backgroundId) {
      // The pty, if any, is only an attach client. Stopping the session is Claude Code's job; the poller reports the result.
      const binary = this.resolveBinary('claude')
      if (!binary) throw new Error('Claude Code is not installed (no "claude" on PATH).')
      await runClaude(binary, ['stop', l.session.backgroundId], existsSync(l.session.cwd) ? l.session.cwd : homedir())
      return
    }
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

  /** Remove a dragon from the kingdom and forget its record. A background dragon's session is removed too (`claude rm`). */
  async dismiss(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    if (l.session.wild) return // the poller removes wild dragons when their sessions go
    if (l.session.backgroundId) {
      const binary = this.resolveBinary('claude')
      if (binary) await runClaude(binary, ['rm', l.session.backgroundId], existsSync(l.session.cwd) ? l.session.cwd : homedir())
    }
    this.forget(id)
  }

  /** Drop a dragon from the kingdom without touching its session. */
  private forget(id: string): void {
    const l = this.live.get(id)
    if (!l) return
    if (l.proc) {
      try {
        l.proc.kill()
      } catch {
        /* already gone */
      }
      l.proc = null
    }
    if (l.gitTimer) clearInterval(l.gitTimer)
    if (l.idleTimer) clearTimeout(l.idleTimer)
    this.live.delete(id)
    this.persist()
    this.emit('removed', id)
  }

  /** On quit: stop the processes but keep every record, so the dragons come back dormant. */
  killAll(): void {
    clearInterval(this.stuckTimer)
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

  /** Apply a hook event forwarded by hooks/notify.js. */
  handleHook(ev: HookEvent): void {
    const p = ev.payload
    // Background dragons post without a dragon id (see hooks/notify.js); find them by the agent's session id.
    const l = ev.dragonId ? this.live.get(ev.dragonId) : this.findBackgroundBySessionId(p.session_id)
    if (!l) return
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
    const sid = str('session_id')
    if (sid && sid !== l.session.claudeSessionId) {
      l.session.claudeSessionId = sid
      this.persist()
    }
    const tool = str('tool_name')

    switch (event) {
      case 'SessionStart':
        break
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.setState(l, 'working')
        break
      case 'PreToolUse': {
        if (tool === 'AskUserQuestion') this.setState(l, 'waiting', 'Asking you a question')
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
        const type = str('notification_type')
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
      if (l.session.backgroundId || l.session.state === 'dead' || l.session.state === 'dormant' || !l.proc) continue
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

  /** An owned background dragon by the agent's session id. Its background id is that UUID's first characters. */
  private findBackgroundBySessionId(sid: unknown): LiveSession | undefined {
    if (typeof sid !== 'string' || !sid) return undefined
    for (const l of this.live.values()) {
      const s = l.session
      if (!s.backgroundId || s.wild) continue
      if (s.claudeSessionId === sid || sid.startsWith(s.backgroundId)) return l
    }
    return undefined
  }

  // ------------------------------------------------------- background dragons

  /**
   * Apply a poll of Claude Code's background sessions (`claude agents --json --all`). Sessions Botalot
   * dispatched update their own dragons; every other one is mirrored as a wild dragon. Each poll is the
   * full truth: wild dragons missing from it leave the kingdom, and owned ones fall.
   */
  applyBackground(entries: BackgroundEntry[], projects: Project[]): void {
    const owned = new Map<string, LiveSession>()
    const ptySessionIds = new Set<string>()
    for (const l of this.live.values()) {
      const s = l.session
      if (s.backgroundId && !s.wild) owned.set(s.backgroundId, l)
      else if (!s.backgroundId && s.claudeSessionId) ptySessionIds.add(s.claudeSessionId)
    }

    const seen = new Set<string>()
    for (const e of entries) {
      const mine = owned.get(e.id)
      if (mine) {
        seen.add(mine.session.id)
        this.applyOwnedBackground(mine, e)
        continue
      }
      if (e.sessionId && ptySessionIds.has(e.sessionId)) continue
      const id = 'wild-' + e.id
      seen.add(id)
      const realm = realmFor(e.cwd, projects)
      const { state, attention } = backgroundState(e)
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
          backgroundId: e.id,
          wild: true,
          pid: e.pid,
          startedAt: e.startedAt ?? Date.now()
        }
        l = { session, proc: null, scrollback: '', lastHookAt: 0, gitTimer: null, idleTimer: null }
        this.live.set(id, l)
        this.startGitPolling(l)
        this.publish(l)
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

    // An owned background dragon whose session is gone (removed elsewhere, or never came up) falls; waking it
    // resumes the conversation in the app's own pty. A short grace covers a dispatch the CLI has not listed yet.
    for (const l of owned.values()) {
      const s = l.session
      if (seen.has(s.id) || s.state === 'dead' || Date.now() - s.startedAt < 15_000) continue
      s.state = 'dead'
      s.stateSince = Date.now()
      s.attention = 'Its background session is gone. Wake to resume it here.'
      s.resumable = existsSync(s.cwd)
      this.publish(l)
    }

    for (const [id, l] of this.live) if (l.session.wild && !seen.has(id)) this.forget(id)
  }

  /** Update a background dragon Botalot dispatched from its poll entry. Recent hooks outrank the poll. */
  private applyOwnedBackground(l: LiveSession, e: BackgroundEntry): void {
    const s = l.session
    let changed = false
    if (e.sessionId && s.claudeSessionId !== e.sessionId) {
      s.claudeSessionId = e.sessionId
      this.persist()
      changed = true
    }
    if (s.pid !== e.pid) {
      s.pid = e.pid
      changed = true
    }
    if (!l.gitTimer) this.startGitPolling(l)
    const { state, attention } = backgroundState(e)
    // Restored dragons start dormant; the first poll that finds their session brings them back whatever the hooks say.
    const hooksRecent = Date.now() - l.lastHookAt < HOOK_AUTHORITY_MS
    if ((s.state === 'dormant' || !hooksRecent) && (s.state !== state || s.attention !== attention)) {
      if (s.state !== state) {
        s.state = state
        s.stateSince = Date.now()
      }
      s.attention = attention
      s.resumable = state === 'dead' ? existsSync(s.cwd) : undefined
      changed = true
    }
    if (changed) this.publish(l)
  }

  /** Open `claude attach <id>` in a pty for a background dragon. Its output streams like any dragon's terminal. */
  attach(id: string): void {
    const l = this.live.get(id)
    if (!l || !l.session.backgroundId || l.proc) return
    const binary = this.resolveBinary('claude')
    if (!binary) {
      l.scrollback = 'Claude Code is not installed (no "claude" on PATH).\r\n'
      this.emit('data', id, l.scrollback)
      return
    }
    let file = binary
    let args = ['attach', l.session.backgroundId]
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

  /** Close a background dragon's attach client. The session keeps running under Claude Code. */
  detach(id: string): void {
    const l = this.live.get(id)
    if (!l || !l.session.backgroundId) return
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

/** "45s" under a minute, "12 min" after. Whole units, so a stuck reason only changes once a minute. */
function duration(ms: number): string {
  return ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)} min`
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

/**
 * Map a background session's state and status onto a dragon state. A session whose process has been
 * stopped (`claude stop`, or the supervisor after an hour unattended) keeps its last state but loses
 * its pid and status, so a missing pid means stopped.
 */
function backgroundState(e: BackgroundEntry): { state: SessionState; attention?: string } {
  const state = String(e.state ?? '').toLowerCase()
  const status = String(e.status ?? '').toLowerCase()
  if (state === 'blocked' || status === 'waiting') return { state: 'waiting', attention: describeWaitingFor(e.waitingFor) }
  if (state === 'failed') return { state: 'dead', attention: 'The background session failed' }
  if (state === 'stopped' || !e.pid) return { state: 'dead', attention: 'Stopped; its transcript is kept' }
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

/**
 * Run a one-shot claude command (`--bg`, `stop`, `rm`) and return its combined output.
 * Never rejects: a failing command's output is the caller's evidence.
 */
function runClaude(binary: string, args: string[], cwd: string): Promise<string> {
  let file = binary
  if (/\.c?js$/i.test(file)) {
    args = [file, ...args]
    file = resolveOnPath('node') ?? 'node'
  }
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: childEnv(), windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}` || (err ? err.message : ''))
    )
  })
}
