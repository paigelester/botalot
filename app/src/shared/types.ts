// Types shared between the Electron main process and the renderer.
import type { Quota } from './quota.ts'
import type { RunView } from './runs.ts'
import type { Board } from './board.ts'

/** dormant = recorded from an earlier run, not running now; wake it to resume the agent's session. */
export type SessionState = 'working' | 'waiting' | 'idle' | 'dead' | 'dormant'

/** projectId of wild dragons whose folder lies outside every realm. They gather in the unclaimed lands. */
export const UNCLAIMED_REALM = 'unclaimed'

/** Which coding agent a dragon runs. */
export type AgentKind = 'claude'

export type WorktreeLayout = 'sibling' | 'inside'

export interface Project {
  id: string
  /** Absolute path to the main checkout. */
  path: string
  name: string
  /** 0xRRGGBB tint applied to this realm's castle and dragons. */
  tint: number
  worktreeLayout: WorktreeLayout
  hidden: boolean
  isGit: boolean
  source: 'discovered' | 'manual'
  /** Issue tracker for this realm. Inferred as github when origin points at github.com, otherwise none. */
  tracker?: Tracker
  /** Patrol: start a factory run for each ticket labelled factory:ready + factory:agent-owned. Off when absent. */
  patrol?: PatrolSettings
}

export interface PatrolSettings {
  enabled: boolean
  /** Most patrol runs going at once in this realm. */
  max: number
}

export interface Worktree {
  path: string
  branch: string
  isMain: boolean
}

export interface GitInfo {
  branch: string
  staged: number
  modified: number
  untracked: number
  ahead: number
  behind: number
}

export interface Session {
  id: string
  name: string
  agent: AgentKind
  projectId: string
  cwd: string
  branch: string
  isWorktree: boolean
  state: SessionState
  stateSince: number
  /** Short human text explaining why the dragon wants attention. */
  attention?: string
  /**
   * Set while the dragon looks stuck: why, e.g. "No activity for 12 min". Derived by the app from timing
   * (working with no activity, or waiting too long), never reported by the agent. Clears on new activity.
   */
  stuck?: string
  /**
   * Set on a run dragon: it stands for a whole run on the map, not for one session. It has no terminal of its
   * own (a run's agent steps are headless); its panel shows the run. Never recorded: the runs folder is the record.
   */
  run?: RunView
  /** The pull request for this dragon's branch, when its realm is on GitHub and one exists. */
  pr?: PullRequestInfo
  /** Most recent hook event name, for debugging and the status strip. */
  lastEvent?: string
  /** The agent's own session id (from the SessionStart hook). Needed to resume. */
  claudeSessionId?: string
  /** True when the dragon can be woken: dormant or dead, with its folder still on disk. */
  resumable?: boolean
  /**
   * Set when the dragon is a Claude Code background session: its `claude agents` id, used to attach,
   * stop and remove it. The session runs under Claude Code's supervisor, not in a pty of the app.
   */
  backgroundId?: string
  /**
   * A wild dragon: a background session Botalot did not summon. Never recorded, slain or woken by the app.
   * Background dragons Botalot summoned itself have backgroundId without wild.
   */
  wild?: boolean
  pid?: number
  startedAt: number
  exitCode?: number
  git?: GitInfo
}

/** Combined result of a pull request's checks. none = no checks reported. */
export type CiStatus = 'pass' | 'pending' | 'fail' | 'none'

export interface PullRequestInfo {
  number: number
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  draft: boolean
  ci: CiStatus
}

export type SpawnTarget =
  | { kind: 'main' }
  | { kind: 'existing'; path: string }
  /** New worktree. `folder` names the worktree directory when it should differ from the branch (draft holdings). */
  | { kind: 'new'; branch: string; folder?: string }

/** Which issue tracker a realm uses. Chosen per realm, not per dragon. */
export type Tracker = { kind: 'none' } | { kind: 'github' }

export interface Issue {
  /** Tracker key: "91" for GitHub. Branches start with it. */
  key: string
  title: string
  body: string
  labels: string[]
  assignees: string[]
  updatedAt: string
  url?: string
  status?: string
}

export interface IssueList {
  tracker: Tracker['kind']
  issues: Issue[]
  /** True when more issues exist than were returned; the picker then offers a server-side search. */
  truncated?: boolean
  /** Set when the tracker is unreachable: gh missing, not logged in, and so on. */
  error?: string
}

export interface SpawnRequest {
  projectId: string
  /** Defaults to claude. */
  agent?: AgentKind
  target: SpawnTarget
  prompt?: string
  name?: string
  /** Run as a background session (`claude --bg`) that keeps going after the app quits. Needs a prompt. */
  background?: boolean
  /** Open an earlier Claude Code session by its id instead of starting a new one, e.g. a run's step. */
  resume?: string
}

export interface DragonApi {
  projects: {
    list(): Promise<Project[]>
    /** Every registered realm, hidden ones included. */
    listAll(): Promise<Project[]>
    /** Opens a folder picker and registers the chosen folder as a realm. */
    add(): Promise<Project | null>
    update(id: string, patch: Partial<Pick<Project, 'name' | 'tint' | 'worktreeLayout' | 'hidden' | 'tracker' | 'patrol'>>): Promise<Project[]>
    /** Deletes the realm. Fails if dragons are still alive there. Returns every remaining realm. */
    remove(id: string): Promise<Project[]>
    worktrees(id: string): Promise<Worktree[]>
    /** Where a new holding's branch would start: the remote default branch, or null if there is no remote. */
    remoteBase(id: string): Promise<string | null>
    /** Set the realm up for the factory (`botalot setup`): write its contract if it has none, and its labels. */
    setup(id: string): Promise<{ ok: boolean; output: string }>
    /** Open issues for the realm from its tracker. `search` asks the tracker itself rather than listing recent ones. */
    issues(id: string, search?: string): Promise<IssueList>
    onChanged(cb: (projects: Project[]) => void): () => void
  }
  sessions: {
    list(): Promise<Session[]>
    spawn(req: SpawnRequest): Promise<Session>
    kill(id: string): Promise<void>
    dismiss(id: string): Promise<void>
    /** Resume a dormant or dead dragon in its folder with the agent's resume flag. */
    wake(id: string): Promise<Session>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    scrollback(id: string): Promise<string>
    /** Background dragons only: run `claude attach` in a pty so the panel's terminal shows the session. */
    attach(id: string): Promise<void>
    /** Background dragons only: close the attach client. The background session keeps running. */
    detach(id: string): Promise<void>
    refreshGit(id: string): Promise<Session | undefined>
    onUpdate(cb: (session: Session) => void): () => void
    onData(cb: (id: string, data: string) => void): () => void
    onRemoved(cb: (id: string) => void): () => void
    /** The main process asks the UI to open a session, e.g. from a notification. */
    onFocus(cb: (id: string) => void): () => void
  }
  board: {
    /** Every realm's board, by realm id. A realm with no GitHub tracker or no contract has none. */
    all(): Promise<Record<string, Board>>
    /** Read a realm's board from GitHub again now. */
    refresh(projectId: string): Promise<void>
    /** Approve a routed ticket (`botalot approve`): it moves from selected to ready. */
    approve(projectId: string, ticket: number): Promise<void>
    /** Pick a refined ticket to work on (`botalot pick`): it moves from refined to selected. */
    pick(projectId: string, ticket: number): Promise<void>
    onUpdate(cb: (boards: Record<string, Board>) => void): () => void
  }
  names: {
    random(): Promise<string>
  }
  app: {
    /** Show the waiting count on the taskbar icon. `png` is the badge image as a data URL; count 0 clears it. */
    setBadge(count: number, png: string | null): void
  }
  runs: {
    /** Every run the driver knows of, newest first. */
    list(): Promise<RunView[]>
    /**
     * Make the ticket's holding and start a run of the implement workflow there. Resolves once the run has
     * begun; rejects with the driver's words when it could not start (no contract, ticket not ready).
     */
    start(projectId: string, issue: Issue): Promise<void>
    /** Carry on a run that is resting (`botalot next`). Resolves once the driver has been started. */
    carryOn(id: string): Promise<void>
    /** End a run, stopping its driver and the agent it is running. */
    stop(id: string): Promise<void>
    /** Open one of a run's agent sessions as a dragon in the run's folder, resuming where the step left off. */
    openSession(runId: string, sessionId: string): Promise<Session>
    onUpdate(cb: (runs: RunView[]) => void): () => void
  }
  quota: {
    /** The latest subscription quota reading from any Claude dragon, or null if none has reported one. */
    get(): Promise<Quota | null>
    onUpdate(cb: (quota: Quota) => void): () => void
  }
}
