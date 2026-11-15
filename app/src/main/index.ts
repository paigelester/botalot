import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { Issue, Project, PullRequestInfo, SpawnRequest } from '@shared/types'
import { parseRateLimits, type Quota } from '@shared/quota'
import { ProjectStore } from './projects'
import { HookServer, removeHookPortFile, writeHookPortFile } from './hooks'
import { ensureClaudeBackgroundHooks, ensureClaudeHooks } from './agents'
import { SessionManager } from './sessions'
import { RegistryWatcher } from './registry'
import { BackgroundWatcher } from './background'
import { Herald } from './herald'
import { PrWatcher } from './prWatcher'
import { Patrol } from './patrol'
import { filePatrolMemory, patrolTrackerFor } from './patrolTrackers'
import { addWorktree, listWorktrees, remoteDefaultBranch } from './git'
import { RunsWatcher, cli, continueRun, setupRealm, shareQuota, startRun, stopRun } from './runs'
import { BoardWatcher } from './board'
import { parseDue, type Due } from '@shared/board'
import { issueBranch } from '@shared/issues'
import { samePath, type RunView } from '@shared/runs'
import { listGitHubIssues } from './github'

// Demo mode must never touch the real config. Unless a user-data-dir was given explicitly,
// move it to a throwaway folder before the app reads anything.
if (process.env.DRAGON_DEMO && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', join(require('os').tmpdir(), 'botalot-demo', 'userdata'))
}

let win: BrowserWindow | null = null
const herald = new Herald(
  () => win,
  (id) => send('session:focus', id)
)
let sessions: SessionManager
let projects: ProjectStore
const hooks = new HookServer()
const registry = new RegistryWatcher()
const background = new BackgroundWatcher()
const runs = new RunsWatcher()
let boards: BoardWatcher
let prs: PrWatcher | null = null
let patrolTimer: NodeJS.Timeout | null = null
/** The latest quota reading from any dragon's status line; null until one arrives. */
let quota: Quota | null = null
const PATROL_MS = 2 * 60_000

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e1a',
    title: 'Botalot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.on('console-message', (ev: unknown) => {
    const e = ev as { level?: string | number; message?: string }
    if (e.level === 'error' || e.level === 'warning' || e.level === 2 || e.level === 3) console.log('[renderer]', e.message)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Start a run for a ticket: in a holding made for it, or in the realm's main checkout, as the workflow asks.
 * Resolves when the run has begun (`begun`: a person started it and only needs to know it did) or when its
 * driver has taken it as far as it can (`rested`: patrol, which counts it as going until then). Rejects with
 * the driver's words when no run could be started at all.
 */
async function startRunFor(p: Project, due: Pick<Due, 'workflow' | 'where' | 'number' | 'title' | 'branch'>, until: 'begun' | 'rested'): Promise<void> {
  // A run on an open pull request goes to the holding of the branch it already has; any other gets one named from its ticket.
  const branch = due.branch ?? issueBranch({ key: String(due.number), title: due.title })
  const cwd = due.where === 'main' ? p.path : (await addWorktree(p.path, branch, p.worktreeLayout)).path
  const since = Date.now()
  const begun = (): boolean => runs.list().some((r) => r.ticket === due.number && r.workflow === due.workflow && samePath(r.mainRepo, p.path) && r.startedAt >= since - 5000)
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    const settle = (err?: Error): void => {
      if (timer) clearInterval(timer)
      if (err) reject(err)
      else resolve()
    }
    startRun(p.path, cwd, due.workflow, due.number, (code, output) => {
      runs.poll()
      // Exit 1 with a run on record is a run that stopped, which shows on the run itself. With none, nothing started.
      settle(code === 1 && !begun() ? new Error(output || 'The driver exited without starting a run.') : undefined)
    })
    if (until === 'begun') {
      timer = setInterval(() => {
        runs.poll()
        if (begun()) settle()
      }, 700)
    } else setTimeout(() => runs.poll(), 2000)
  })
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => projects.visible())
  ipcMain.handle('projects:listAll', () => projects.all())
  ipcMain.handle('projects:add', () => projects.addViaDialog())
  ipcMain.handle('projects:update', (_e, id: string, patch) => projects.update(id, patch))
  ipcMain.handle('projects:remove', (_e, id: string) => {
    // Wild dragons are not ours to slay; on the next poll they move to the unclaimed lands.
    const owned = sessions.list().filter((s) => s.projectId === id && !s.wild)
    const alive = owned.filter((s) => s.state !== 'dead')
    if (alive.length > 0) throw new Error(alive.length + ' dragon(s) still live in that realm. Slay them first.')
    for (const s of owned) sessions.dismiss(s.id)
    return projects.remove(id)
  })
  ipcMain.handle('projects:worktrees', async (_e, id: string) => {
    const p = projects.get(id)
    return p ? listWorktrees(p.path) : []
  })
  ipcMain.handle('projects:issues', async (_e, id: string, search?: string) => {
    const p = projects.get(id)
    if (!p) return { tracker: 'none', issues: [], error: 'Unknown realm' }
    const t = p.tracker ?? { kind: 'none' as const }
    if (t.kind === 'github') return listGitHubIssues(p.path, search)
    return { tracker: 'none', issues: [] }
  })
  ipcMain.handle('projects:setup', async (_e, id: string) => {
    const p = projects.get(id)
    if (!p) throw new Error('Unknown realm')
    return setupRealm(p.path)
  })
  ipcMain.handle('projects:remoteBase', async (_e, id: string) => {
    const p = projects.get(id)
    return p && p.isGit ? remoteDefaultBranch(p.path) : null
  })

  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:spawn', async (_e, req: SpawnRequest) => {
    const p = projects.get(req.projectId)
    if (!p) throw new Error('Unknown realm')
    return sessions.spawn(req, p)
  })
  ipcMain.handle('sessions:kill', (_e, id: string) => sessions.kill(id))
  ipcMain.handle('sessions:dismiss', (_e, id: string) => sessions.dismiss(id))
  ipcMain.handle('sessions:wake', (_e, id: string) => sessions.wake(id, (pid) => projects.get(pid)))
  ipcMain.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
  ipcMain.handle('sessions:scrollback', (_e, id: string) => sessions.scrollback(id))
  ipcMain.handle('sessions:refreshGit', (_e, id: string) => sessions.refreshGit(id))
  ipcMain.handle('sessions:attach', (_e, id: string) => sessions.attach(id))
  ipcMain.handle('sessions:detach', (_e, id: string) => sessions.detach(id))

  ipcMain.handle('names:random', () => sessions.randomName())
  ipcMain.handle('runs:list', () => runs.list())
  ipcMain.handle('runs:start', async (_e, projectId: string, issue: Issue) => {
    const p = projects.get(projectId)
    if (!p) throw new Error('Unknown realm')
    await startRunFor(p, { workflow: 'implement', where: 'holding', number: Number(issue.key), title: issue.title }, 'begun')
    void boards.poll(p.id)
  })
  ipcMain.handle('board:all', () => boards.all())
  ipcMain.handle('board:refresh', (_e, projectId: string) => boards.poll(projectId))
  ipcMain.handle('board:approve', async (_e, projectId: string, ticket: number) => {
    const p = projects.get(projectId)
    if (!p) throw new Error('Unknown realm')
    const r = await cli(['approve', String(ticket)], p.path, p.path)
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'botalot approve failed')
    await boards.poll(p.id)
  })
  ipcMain.handle('runs:carryOn', (_e, id: string) => {
    const run = runs.get(id)
    if (!run) throw new Error('No such run')
    continueRun(run, (code, output) => {
      if (code === 1) console.log('[runs] could not carry on', id, output)
      runs.poll()
    })
    setTimeout(() => runs.poll(), 1500)
  })
  ipcMain.handle('runs:stop', (_e, id: string) => {
    const run = runs.get(id)
    if (!run) throw new Error('No such run')
    stopRun(run, () => runs.poll())
  })
  ipcMain.handle('runs:openSession', async (_e, runId: string, sessionId: string) => {
    const run = runs.get(runId)
    if (!run) throw new Error('No such run')
    const p = projects.all().find((x) => samePath(x.path, run.mainRepo))
    if (!p) throw new Error(run.repoName + ' is not a realm. Add its folder in Realms, then open the session.')
    const target = samePath(run.cwd, p.path) ? ({ kind: 'main' } as const) : ({ kind: 'existing', path: run.cwd } as const)
    const s = await sessions.spawn({ projectId: p.id, target, resume: sessionId }, p)
    send('session:focus', s.id)
    return s
  })
  ipcMain.handle('quota:get', () => quota)
  ipcMain.on('app:badge', (_e, count: number, png: string | null) => herald.setBadge(count, png))
}

// Windows only shows toast notifications for an app with an AppUserModelID; match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('com.paigelester.botalot')

app.whenReady().then(async () => {
  const port = await hooks.start()
  writeHookPortFile(port)
  const settingsPath = ensureClaudeHooks()
  projects = new ProjectStore()
  boards = new BoardWatcher(() => projects.all())
  void projects.inferTrackers()
  sessions = new SessionManager(port, settingsPath, ensureClaudeBackgroundHooks())
  sessions.restore((pid) => projects.get(pid))

  // Status line readings carry the account's quota, not a dragon's activity, so they skip the session.
  hooks.on('event', (ev) => {
    if (ev.payload.hook_event_name !== 'StatusLine') return sessions.handleHook(ev)
    const q = parseRateLimits(ev.payload)
    if (!q) return
    quota = q
    send('quota:update', q)
    shareQuota(q)
  })
  registry.on('registry', (entries) => sessions.applyRegistry(entries))
  registry.start()
  // The demo kingdom is fictional, so real background sessions stay out of it.
  if (!process.env.DRAGON_DEMO && !process.env.DRAGON_DEMO_PLAN) {
    background.on('background', (entries) => sessions.applyBackground(entries, projects.all()))
    background.start()
  }

  sessions.on('update', (s) => send('session:update', s))
  sessions.on('removed', (id) => send('session:removed', id))
  sessions.on('update', (s) => herald.observe(s))
  sessions.on('removed', (id) => herald.forget(id))
  prs = new PrWatcher(
    () => sessions.list(),
    (id) => projects.get(id),
    (id, pr) => sessions.setPr(id, pr)
  )
  sessions.on('update', (s) => prs?.observe(s))
  sessions.on('removed', (id) => prs?.forget(id))
  // The demo's realms are fictional: no GitHub to ask.
  if (!process.env.DRAGON_DEMO && !process.env.DRAGON_DEMO_PLAN) prs.start()

  // Factory runs. The demo kingdom is fictional, so it shows runs only from a runs folder made for it (BOTALOT_HOME).
  const demo = !!process.env.DRAGON_DEMO || !!process.env.DRAGON_DEMO_PLAN
  if (!demo || process.env.BOTALOT_HOME) {
    let statuses = ''
    runs.on('runs', (list: RunView[]) => {
      send('runs:update', list)
      sessions.applyRuns(list, projects.all())
      // A run starting, resting or finishing moves tickets on and off the boards; a run merely working doesn't.
      const now = list.map((r) => r.id + r.status).join('|')
      if (now !== statuses) void boards.poll()
      statuses = now
    })
    // A realm added or removed changes which runs have a castle to stand by.
    projects.on('changed', () => sessions.applyRuns(runs.list(), projects.all()))
    runs.start()
  }

  // Boards come from GitHub, which the fictional demo kingdom doesn't have: it shows boards only from a file made for it.
  if (!demo || process.env.DRAGON_DEMO_BOARDS) {
    boards.on('boards', (all) => send('board:update', all))
    boards.start()
  }

  // Patrol goes every couple of minutes, and soon after a realm's patrol is switched on.
  if (!demo) {
    const patrol = new Patrol({
      projects: () => projects.all(),
      runs: () => runs.list(),
      trackerFor: patrolTrackerFor,
      due: async (p) => {
        const r = await cli(['due', '--json'], p.path, p.path)
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'botalot due failed')
        return parseDue(JSON.parse(r.stdout))
      },
      start: (p, due) => startRunFor(p, due, 'rested'),
      memory: filePatrolMemory(),
      log: (m) => console.log('[patrol]', m)
    })
    const round = () => void patrol.tick()
    setTimeout(round, 20_000)
    patrolTimer = setInterval(round, PATROL_MS)
    let wasOn = new Set(projects.all().filter((p) => p.patrol?.enabled).map((p) => p.id))
    projects.on('changed', () => {
      const on = new Set(projects.all().filter((p) => p.patrol?.enabled).map((p) => p.id))
      if ([...on].some((id) => !wasOn.has(id))) setTimeout(round, 5_000)
      wasOn = on
    })
  }
  sessions.on('data', (id, data) => send('session:data', id, data))
  projects.on('changed', (list) => send('projects:changed', list))

  registerIpc()
  createWindow()
  await runDevHelpers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** DRAGON_DEMO=1 fills the kingdom with fake dragons; DRAGON_SCREENSHOT=<png> captures the window and quits. */
async function runDevHelpers(): Promise<void> {
  if (process.env.DRAGON_DEMO_PLAN) {
    // A scripted kingdom (scripts/demo/demo.cjs): fake realms and a cast of dragons across castles and holdings.
    // pr stands in for what the PR watcher would find on GitHub; the demo has no GitHub to ask.
    type Planned = { projectId: string; name: string; scenario: string; path?: string; prompt?: string; pr?: PullRequestInfo }
    const plan = JSON.parse(require('fs').readFileSync(process.env.DRAGON_DEMO_PLAN, 'utf8')) as Planned[]
    for (const d of plan) {
      const p = projects.get(d.projectId)
      if (!p) continue
      process.env.DRAGON_DEMO_SCENARIO = d.scenario
      const target = d.path ? { kind: 'existing' as const, path: d.path } : { kind: 'main' as const }
      try {
        const s = await sessions.spawn({ projectId: p.id, target, prompt: d.prompt, name: d.name }, p)
        if (d.pr) sessions.setPr(s.id, d.pr)
      } catch (err) {
        console.warn('[demo] could not summon', d.name, (err as Error).message)
      }
    }
  } else if (process.env.DRAGON_DEMO) {
    sessions.on('update', (s) => console.log('[demo]', s.name, s.state, s.lastEvent ?? '', s.attention ?? ''))
    const list = projects.visible()
    const scenarios = ['quest', 'waiting', 'idle', 'dead', 'quest', 'waiting']
    // Put the waiting dragon in a worktree holding if any realm has one, so holdings get exercised.
    let holding: { project: (typeof list)[number]; path: string } | null = null
    for (const p of list) {
      const extra = (await listWorktrees(p.path)).find((t) => !t.isMain)
      if (extra) {
        holding = { project: p, path: extra.path }
        break
      }
    }
    let focusId: string | null = null
    for (let i = 0; i < Math.min(scenarios.length, Math.max(1, list.length) * 2); i++) {
      const p = i === 1 && holding ? holding.project : list[i % list.length]
      if (!p) break
      const target = i === 1 && holding ? { kind: 'existing' as const, path: holding.path } : { kind: 'main' as const }
      process.env.DRAGON_DEMO_SCENARIO = scenarios[i]
      const s = await sessions.spawn({ projectId: p.id, target, prompt: i % 2 === 0 ? 'demo quest' : undefined }, p)
      if (i === 1) focusId = s.id
    }
    if (process.env.DRAGON_DEMO_FOCUS && focusId) setTimeout(() => send('session:focus', focusId), 5000)
  }
  // DRAGON_FOCUS_ID=<dragon id> opens that dragon's panel once the kingdom has settled (used by screenshot tests).
  const focus = process.env.DRAGON_FOCUS_ID
  if (focus) setTimeout(() => send('session:focus', focus), 6000)
  // DRAGON_FOCUS_NEW=1 opens the panel for every newly summoned dragon (used by screenshot tests).
  if (process.env.DRAGON_FOCUS_NEW) {
    const seen = new Set<string>()
    sessions.on('update', (s) => {
      if (seen.has(s.id)) return
      seen.add(s.id)
      setTimeout(() => send('session:focus', s.id), 300)
    })
  }
  const shot = process.env.DRAGON_SCREENSHOT
  if (shot && win) {
    const delay = Number(process.env.DRAGON_SCREENSHOT_DELAY || 5000)
    setTimeout(async () => {
      try {
        if (process.env.DRAGON_DOM_DUMP) console.log('[dom]', await win!.webContents.executeJavaScript(process.env.DRAGON_DOM_DUMP))
        const img = await win!.webContents.capturePage()
        require('fs').writeFileSync(shot, img.toPNG())
        console.log('screenshot written', shot)
      } catch (err) {
        console.error('screenshot failed', err)
      }
      app.quit()
      setTimeout(() => app.exit(0), 4000).unref()
    }, delay)
  }
}

app.on('before-quit', () => {
  sessions?.killAll()
  registry.stop()
  background.stop()
  runs.stop()
  boards?.stop()
  prs?.stop()
  if (patrolTimer) clearInterval(patrolTimer)
  hooks.stop()
  removeHookPortFile()
})

app.on('window-all-closed', () => {
  app.quit()
})
