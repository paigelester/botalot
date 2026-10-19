import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { SpawnRequest } from '@shared/types'
import { ProjectStore } from './projects'
import { HookServer, removeHookPortFile, writeHookPortFile } from './hooks'
import { ensureClaudeBackgroundHooks, ensureClaudeHooks, listAgents } from './agents'
import { SessionManager } from './sessions'
import { RegistryWatcher } from './registry'
import { BackgroundWatcher } from './background'
import { Herald } from './herald'
import { listWorktrees, remoteDefaultBranch } from './git'
import { listGitHubIssues } from './github'
import { listJiraIssues, testJira } from './jira'
import { listJiraSites, removeJiraSite, saveJiraSite } from './secrets'

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
    if (t.kind === 'jira') return listJiraIssues(t, search)
    return { tracker: 'none', issues: [] }
  })

  ipcMain.handle('jira:sites', () => listJiraSites())
  ipcMain.handle('jira:saveSite', (_e, site: string, email: string, token: string) => {
    saveJiraSite(site, email, token)
    return listJiraSites()
  })
  ipcMain.handle('jira:removeSite', (_e, site: string) => {
    removeJiraSite(site)
    return listJiraSites()
  })
  ipcMain.handle('jira:test', (_e, site: string) => testJira(site))
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
  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.on('app:badge', (_e, count: number, png: string | null) => herald.setBadge(count, png))
}

// Windows only shows toast notifications for an app with an AppUserModelID; match electron-builder's appId.
if (process.platform === 'win32') app.setAppUserModelId('com.paigelester.botalot')

app.whenReady().then(async () => {
  const port = await hooks.start()
  writeHookPortFile(port)
  const settingsPath = ensureClaudeHooks()
  projects = new ProjectStore()
  void projects.inferTrackers()
  sessions = new SessionManager(port, settingsPath, ensureClaudeBackgroundHooks())
  sessions.restore((pid) => projects.get(pid))

  hooks.on('event', (ev) => sessions.handleHook(ev))
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
    type Planned = { projectId: string; name: string; agent: 'claude' | 'copilot'; scenario: string; path?: string; prompt?: string }
    const plan = JSON.parse(require('fs').readFileSync(process.env.DRAGON_DEMO_PLAN, 'utf8')) as Planned[]
    for (const d of plan) {
      const p = projects.get(d.projectId)
      if (!p) continue
      process.env.DRAGON_DEMO_SCENARIO = d.scenario
      const target = d.path ? { kind: 'existing' as const, path: d.path } : { kind: 'main' as const }
      try {
        await sessions.spawn({ projectId: p.id, agent: d.agent, target, prompt: d.prompt, name: d.name }, p)
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
      const agent = i === scenarios.length - 1 ? ('copilot' as const) : ('claude' as const)
      if (agent === 'copilot') process.env.DRAGON_COPILOT_BIN = process.env.DRAGON_COPILOT_BIN || process.env.DRAGON_CLAUDE_BIN || ''
      const s = await sessions.spawn({ projectId: p.id, agent, target, prompt: i % 2 === 0 ? 'demo quest' : undefined }, p)
      if (i === 1) focusId = s.id
    }
    if (process.env.DRAGON_DEMO_FOCUS && focusId) setTimeout(() => send('session:focus', focusId), 5000)
  }
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
  hooks.stop()
  removeHookPortFile()
})

app.on('window-all-closed', () => {
  app.quit()
})
