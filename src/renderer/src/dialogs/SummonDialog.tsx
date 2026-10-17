import { useEffect, useState } from 'react'
import type { AgentInfo, AgentKind, Issue, IssueList, Project, SpawnRequest, Tracker, Worktree } from '@shared/types'
import { api } from '../api'
import { IssuePicker } from './IssuePicker'

interface Props {
  projects: Project[]
  initialProjectId: string | null
  onClose(): void
  onSummoned(): void
}

type Mode = 'main' | 'existing' | 'new'
/** How a new holding gets its name. */
type Naming = 'issue' | 'manual' | 'draft'

const TRACKER_NAME: Record<Tracker['kind'], string> = { none: 'tracker', github: 'GitHub', jira: 'Jira' }

/** Branch-safe slug from an issue title: drops leading tags like [WORK] or (You), cuts at a word boundary. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .replace(/^(\s*(\[[^\]]*\]|\([^)]*\)))+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max + 1)
  const atWord = cut.lastIndexOf('-')
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut.slice(0, max)).replace(/-+$/g, '')
}

function issueBranch(issue: Issue): string {
  return `${issue.key}-${slugify(issue.title)}`
}

function issuePrompt(issue: Issue, tracker: Tracker['kind']): string {
  const body = issue.body.trim()
  const ref = tracker === 'github' ? `GitHub issue #${issue.key}` : `${TRACKER_NAME[tracker]} issue ${issue.key}`
  const link = issue.url ? `\n${issue.url}` : ''
  return `Work on ${ref}: ${issue.title}${link}\n\n${body || '(no description)'}\n\nThis worktree is on branch ${issueBranch(issue)}. Start by reading the relevant code and proposing a short plan before changing anything.`
}

function draftPrompt(branch: string, tracker: Tracker['kind']): string {
  const file =
    tracker === 'github'
      ? 'create a GitHub issue for it with `gh issue create`'
      : tracker === 'jira'
        ? 'ask me to create the Jira issue and give you its key'
        : 'ask me whether a ticket is needed'
  return `I have a rough idea I want to think through with you before any code is written. Ask me questions until we both understand it. Do not edit files yet.

When I say "go": ${file}, then rename this branch to <issue-key>-<short-slug> with \`git branch -m ${branch} <new-name>\`, and start implementing.`
}

/** The summoning circle: choose a realm, an agent, a holding, a name, and a first quest. */
export function SummonDialog({ projects, initialProjectId, onClose, onSummoned }: Props) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? '')
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [agent, setAgent] = useState<AgentKind>(() => {
    try {
      return (localStorage.getItem('dragon.lastAgent') as AgentKind) || 'claude'
    } catch {
      return 'claude'
    }
  })
  const [mode, setMode] = useState<Mode>('main')
  const [naming, setNaming] = useState<Naming>('issue')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [mainBranch, setMainBranch] = useState('')
  const [remoteBase, setRemoteBase] = useState<string | null>(null)
  const [existingPath, setExistingPath] = useState('')
  const [issue, setIssue] = useState<Issue | null>(null)
  const [issuesState, setIssuesState] = useState<IssueList | null>(null)
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const project = projects.find((p) => p.id === projectId)
  const tracker: Tracker['kind'] = project?.tracker?.kind ?? 'none'
  const trackerReady = tracker !== 'none'
  const dragonSlug = slugify(name) || 'dragon'

  useEffect(() => {
    void api.names.random().then(setName)
    void api.agents.list().then((list) => {
      setAgents(list)
      setAgent((a) => (list.find((x) => x.id === a)?.path ? a : (list.find((x) => x.path)?.id ?? a)))
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('dragon.lastAgent', agent)
    } catch {
      /* private mode */
    }
  }, [agent])

  useEffect(() => {
    if (!projectId) return
    void api.projects.worktrees(projectId).then((list) => {
      const extra = list.filter((w) => !w.isMain)
      setWorktrees(extra)
      setMainBranch(list.find((w) => w.isMain)?.branch ?? '')
      setExistingPath(extra[0]?.path ?? '')
    })
    void api.projects.remoteBase(projectId).then(setRemoteBase)
    setIssue(null)
    setIssuesState(null)
    // Realms without a tracker cannot name holdings from an issue.
    setNaming((n) => (trackerReady ? (n === 'manual' && !branch.trim() ? 'issue' : n) : n === 'issue' ? 'manual' : n))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Prefill the opening prompt when the naming choice or the chosen issue changes.
  useEffect(() => {
    if (mode !== 'new') return
    if (naming === 'issue' && issue) setPrompt(issuePrompt(issue, tracker))
    else if (naming === 'draft') setPrompt(draftPrompt(`draft/${dragonSlug}`, tracker))
    else if (naming === 'manual') setPrompt((p) => (p.startsWith('Work on ') || p.startsWith('I have a rough idea') ? '' : p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, naming, issue?.key])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Branch and folder the new holding will get. */
  function newTarget(): { branch: string; folder?: string } | string {
    if (naming === 'issue') {
      if (!issue) return `Pick a ${TRACKER_NAME[tracker]} issue.`
      return { branch: issueBranch(issue) }
    }
    if (naming === 'draft') return { branch: `draft/${dragonSlug}`, folder: dragonSlug }
    if (!branch.trim()) return 'Name the branch for the new holding.'
    return { branch: branch.trim() }
  }

  async function summon() {
    if (!project) return
    setError(null)
    let target: SpawnRequest['target']
    if (mode === 'new') {
      const t = newTarget()
      if (typeof t === 'string') {
        setError(t)
        return
      }
      target = { kind: 'new', ...t }
    } else if (mode === 'existing') {
      if (!existingPath) {
        setError('No existing holding to use.')
        return
      }
      target = { kind: 'existing', path: existingPath }
    } else {
      target = { kind: 'main' }
    }
    setBusy(true)
    try {
      await api.sessions.spawn({ projectId: project.id, agent, target, prompt: prompt.trim() || undefined, name: name.trim() || undefined })
      onSummoned()
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  const preview = mode === 'new' ? newTarget() : null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Summon a dragon</h2>

        <label>
          Realm
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.path}
                {p.tracker && p.tracker.kind !== 'none' ? ` · ${TRACKER_NAME[p.tracker.kind]}` : ''}
              </option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend>Which kind of dragon?</legend>
          <div className="agent-row">
            {agents.map((a) => (
              <label key={a.id} className={'agent-choice' + (agent === a.id ? ' selected' : '') + (a.path ? '' : ' unavailable')} title={a.path ?? a.note}>
                <input type="radio" checked={agent === a.id} disabled={!a.path} onChange={() => setAgent(a.id)} />
                <b>{a.label}</b>
                {!a.path ? <span className="hint block">Not installed</span> : null}
              </label>
            ))}
          </div>
          {agents.find((a) => a.id === agent)?.note ? <span className="hint block">{agents.find((a) => a.id === agent)?.note}</span> : null}
        </fieldset>

        <fieldset>
          <legend>Where does it roost?</legend>
          <label className="radio">
            <input type="radio" checked={mode === 'main'} onChange={() => setMode('main')} />
            <span>
              <b>Inside the castle</b> — the repo folder itself, as it is right now
              {project?.isGit ? (mainBranch ? ` (on ${mainBranch})` : '') : ' (not a git repo)'}
              <span className="hint block">No worktree, no fetch. Same as opening a terminal in the folder. Shares files with anything else working there.</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={mode === 'existing'} disabled={worktrees.length === 0} onChange={() => setMode('existing')} />
            <span>
              <b>An existing holding</b> — a worktree you already have
              <span className="hint block">Its own folder and branch, already on disk.</span>
            </span>
            {mode === 'existing' ? (
              <select value={existingPath} onChange={(e) => setExistingPath(e.target.value)}>
                {worktrees.map((w) => (
                  <option key={w.path} value={w.path}>
                    {w.branch} — {w.path}
                  </option>
                ))}
              </select>
            ) : worktrees.length === 0 ? (
              <span className="hint"> (none yet)</span>
            ) : null}
          </label>
          <label className="radio">
            <input type="radio" checked={mode === 'new'} disabled={!project?.isGit} onChange={() => setMode('new')} />
            <span>
              <b>A new holding</b> — create a worktree on a new branch
              <span className="hint block">
                {remoteBase
                  ? `Fetches origin first, then branches from the latest ${remoteBase}, not your local copy.`
                  : `No remote found, so the branch starts from the castle's current ${mainBranch || 'HEAD'}.`}{' '}
                Own folder, so this dragon never collides with others.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === 'new' ? (
          <fieldset>
            <legend>What is the holding called?</legend>
            <label className="radio">
              <input type="radio" checked={naming === 'issue'} disabled={!trackerReady} onChange={() => setNaming('issue')} />
              <span>
                <b>From {tracker === 'none' ? 'an issue' : `a ${TRACKER_NAME[tracker]} issue`}</b>
                {!trackerReady ? <span className="hint block">This realm has no tracker. Set one in Realms.</span> : null}
              </span>
              {naming === 'issue' && trackerReady && project ? (
                <IssuePicker projectId={project.id} tracker={tracker} selected={issue} onSelect={setIssue} onLoaded={setIssuesState} />
              ) : null}
            </label>
            <label className="radio">
              <input type="radio" checked={naming === 'manual'} onChange={() => setNaming('manual')} />
              <span>
                <b>Name it myself</b>
              </span>
              {naming === 'manual' ? (
                <input type="text" placeholder="branch name, e.g. 42-add-login or PLAT-123-add-login" value={branch} onChange={(e) => setBranch(e.target.value)} autoFocus />
              ) : null}
            </label>
            <label className="radio">
              <input type="radio" checked={naming === 'draft'} onChange={() => setNaming('draft')} />
              <span>
                <b>Draft, name it later</b> — talk it through first
                <span className="hint block">
                  Folder and branch are named after the dragon. When the idea is clear the dragon files the issue and renames its own branch; the map
                  follows along.
                </span>
              </span>
            </label>
            {typeof preview === 'object' && preview ? (
              <div className="hint">
                Branch <code>{preview.branch}</code> in folder <code>{preview.folder ?? preview.branch}</code>
              </div>
            ) : null}
            {issuesState?.error && naming !== 'issue' ? <div className="hint">{issuesState.error}</div> : null}
          </fieldset>
        ) : null}

        <label>
          Dragon name
          <span className="row">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" className="ghost" onClick={() => void api.names.random().then(setName)} title="Another name">
              🎲
            </button>
          </span>
        </label>

        <label>
          First quest (optional opening prompt)
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Leave empty to start idle and type in the terminal." />
        </label>

        {error ? <div className="error">{error}</div> : null}

        <div className="actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void summon()} disabled={busy || !project}>
            {busy ? 'Summoning…' : 'Summon'}
          </button>
        </div>
      </div>
    </div>
  )
}
