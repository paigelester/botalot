// Types shared between the Electron main process and the renderer.

/** dormant = recorded from an earlier run, not running now; wake it to resume the agent's session. */
export type SessionState = 'working' | 'waiting' | 'idle' | 'dead' | 'dormant'

/** projectId of wild dragons whose folder lies outside every realm. They gather in the unclaimed lands. */
export const UNCLAIMED_REALM = 'unclaimed'

/** Which coding agent a dragon runs. */
export type AgentKind = 'claude' | 'copilot'

export interface AgentInfo {
  id: AgentKind
  label: string
  /** Resolved executable, or null when not installed. */
  path: string | null
  /** Human note, e.g. how to install, or how state is detected. */
  note?: string
}

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
  /** Most recent hook event name, for debugging and the status strip. */
  lastEvent?: string
  /** The agent's own session id (Claude: from the SessionStart hook; Copilot: set by the app). Needed to resume. */
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

export type SpawnTarget =
  | { kind: 'main' }
  | { kind: 'existing'; path: string }
  /** New worktree. `folder` names the worktree directory when it should differ from the branch (draft holdings). */
  | { kind: 'new'; branch: string; folder?: string }

/** Which issue tracker a realm uses. Chosen per realm, not per dragon. */
export type Tracker =
  | { kind: 'none' }
  | { kind: 'github' }
  | {
      kind: 'jira'
      /** Jira site, e.g. https://acme.atlassian.net. Credentials are stored per site. */
      site: string
      /** Project key such as PLAT. Issues are listed from this project unless jql is set. */
      projectKey: string
      /** Optional JQL that replaces the default "open issues in project" query. */
      jql?: string
    }

export interface Issue {
  /** Tracker key: "91" for GitHub, "PLAT-123" for Jira. Branches start with it. */
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
  /** Set when the tracker is unreachable: gh missing, not logged in, bad Jira credentials, and so on. */
  error?: string
}

/** A Jira site the user has credentials for. The token itself never leaves the main process. */
export interface JiraSite {
  site: string
  email: string
  hasToken: boolean
}

export interface SpawnRequest {
  projectId: string
  /** Defaults to claude. */
  agent?: AgentKind
  target: SpawnTarget
  prompt?: string
  name?: string
  /** Claude only: run as a background session (`claude --bg`) that keeps going after the app quits. Needs a prompt. */
  background?: boolean
}

export interface DragonApi {
  projects: {
    list(): Promise<Project[]>
    /** Every registered realm, hidden ones included. */
    listAll(): Promise<Project[]>
    /** Opens a folder picker and registers the chosen folder as a realm. */
    add(): Promise<Project | null>
    update(id: string, patch: Partial<Pick<Project, 'name' | 'tint' | 'worktreeLayout' | 'hidden' | 'tracker'>>): Promise<Project[]>
    /** Deletes the realm. Fails if dragons are still alive there. Returns every remaining realm. */
    remove(id: string): Promise<Project[]>
    worktrees(id: string): Promise<Worktree[]>
    /** Where a new holding's branch would start: the remote default branch, or null if there is no remote. */
    remoteBase(id: string): Promise<string | null>
    /** Open issues for the realm from its tracker. `search` asks the tracker itself rather than listing recent ones. */
    issues(id: string, search?: string): Promise<IssueList>
    onChanged(cb: (projects: Project[]) => void): () => void
  }
  jira: {
    sites(): Promise<JiraSite[]>
    /** Saves credentials for a site. An empty token keeps the existing one. */
    saveSite(site: string, email: string, token: string): Promise<JiraSite[]>
    removeSite(site: string): Promise<JiraSite[]>
    /** Checks the credentials by calling the Jira API. Returns the display name, or throws. */
    test(site: string): Promise<string>
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
  names: {
    random(): Promise<string>
  }
  agents: {
    list(): Promise<AgentInfo[]>
  }
}
