// `npm run demo`: a self-contained show kingdom. Fictional realms are created as real throwaway
// git repos (with worktrees) under the system temp folder, the app runs with its own config
// folder so your real kingdom is untouched, and fake dragons walk through every state.
// Pass --shot=<file.png> to capture a screenshot after a few seconds and exit.
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const root = path.join(__dirname, '..', '..')
const demoRoot = path.join(os.tmpdir(), 'botalot-demo')
const realmsDir = path.join(demoRoot, 'realms')
const userData = path.join(demoRoot, 'userdata')
fs.mkdirSync(realmsDir, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Botalot', '-c', 'user.email=demo@example.com', ...args], { cwd, stdio: 'pipe', windowsHide: true }).toString()
}

/** Create a realm repo with a commit, plus worktrees for the given branches. Idempotent. */
function realm(name, files, branches) {
  const repo = path.join(realmsDir, name)
  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main') // older git lacks `init -b`
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content)
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'Found the realm')
  }
  const holdings = {}
  for (const branch of branches) {
    const leaf = branch.replace(/[\\/:*?"<>|]/g, '-')
    const wt = path.join(realmsDir, `${name}-worktrees`, leaf)
    if (!fs.existsSync(wt)) {
      fs.mkdirSync(path.dirname(wt), { recursive: true })
      try {
        git(repo, 'worktree', 'add', '-q', '-b', branch, wt)
      } catch {
        git(repo, 'worktree', 'add', '-q', wt, branch)
      }
      // A little uncommitted work so the git counters show something.
      fs.writeFileSync(path.join(wt, 'notes.md'), `# ${branch}\n\nWork in progress.\n`)
    }
    holdings[branch] = wt
  }
  return { repo, holdings }
}

const readme = (title, blurb) => ({ 'README.md': `# ${title}\n\n${blurb}\n`, 'src.txt': 'placeholder source\n' })

const realms = [
  { id: 'demo-dragonforge', name: 'Dragonforge', tint: 0xe05a3a, tracker: { kind: 'github' }, ...realm('dragonforge', readme('Dragonforge', 'Where the kingdom smelts its code.'), ['142-forge-cooling', 'draft/ember']) },
  { id: 'demo-skyharbour', name: 'Skyharbour', tint: 0x3a8fe0, tracker: { kind: 'jira', site: 'https://skyharbour.atlassian.net', projectKey: 'SKY' }, ...realm('skyharbour', readme('Skyharbour', 'Docks for the airships.'), ['SKY-87-dock-scheduler']) },
  { id: 'demo-ravenmoor', name: 'Ravenmoor', tint: 0x9c5be0, tracker: { kind: 'github' }, ...realm('ravenmoor', readme('Ravenmoor', 'Messaging across the moors.'), ['203-raven-post']) },
  { id: 'demo-thornfield', name: 'Thornfield', tint: 0x4fb563, tracker: { kind: 'none' }, ...realm('thornfield', readme('Thornfield', 'Hedge mazes and test suites.'), []) },
  { id: 'demo-mistral-docks', name: 'Mistral Docks', tint: 0xd8a53b, tracker: { kind: 'none' }, ...realm('mistral-docks', readme('Mistral Docks', 'Wind-powered deployments.'), ['31-weather-vane']) }
]

// Config for the demo kingdom: only these realms, no discovery.
const config = {
  projects: realms.map((r) => ({ id: r.id, path: r.repo, name: r.name, tint: r.tint, worktreeLayout: 'sibling', hidden: false, isGit: true, source: 'manual', tracker: r.tracker })),
  ignored: []
}
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2))

// One dragon remembered from "an earlier run", so the dormant state shows too.
const dormant = {
  id: crypto.randomUUID(),
  name: 'Halcyon',
  agent: 'claude',
  projectId: 'demo-mistral-docks',
  cwd: realms[4].holdings['31-weather-vane'],
  branch: '31-weather-vane',
  isWorktree: true,
  startedAt: Date.now() - 86_400_000,
  agentSessionId: crypto.randomUUID(),
  lastSeenAt: Date.now() - 3_600_000
}
fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify({ sessions: [dormant] }, null, 2))

// Who flies where. scenario drives the fake agent in scripts/demo/demo-claude.cjs.
const plan = [
  { projectId: 'demo-dragonforge', name: 'Ember', agent: 'claude', scenario: 'busy', prompt: 'Forge the cooling system' },
  { projectId: 'demo-dragonforge', name: 'Vyrax', agent: 'copilot', scenario: 'waiting', path: realms[0].holdings['142-forge-cooling'] },
  { projectId: 'demo-dragonforge', name: 'Sylthra', agent: 'claude', scenario: 'idle', path: realms[0].holdings['draft/ember'] },
  { projectId: 'demo-skyharbour', name: 'Nimbus', agent: 'claude', scenario: 'idle' },
  { projectId: 'demo-skyharbour', name: 'Tidewing', agent: 'copilot', scenario: 'busy', path: realms[1].holdings['SKY-87-dock-scheduler'], prompt: 'Schedule the docks' },
  { projectId: 'demo-ravenmoor', name: 'Umbra', agent: 'claude', scenario: 'busy', prompt: 'Deliver the ravens' },
  { projectId: 'demo-ravenmoor', name: 'Morrow', agent: 'claude', scenario: 'dead', path: realms[2].holdings['203-raven-post'] },
  { projectId: 'demo-thornfield', name: 'Thornmaw', agent: 'claude', scenario: 'waiting', prompt: 'Trim the hedges' },
  { projectId: 'demo-thornfield', name: 'Kaelith', agent: 'copilot', scenario: 'busy', prompt: 'Run the test suite' }
]
const planPath = path.join(userData, 'demo-plan.json')
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2))

const fake = path.join(root, 'scripts', 'demo', 'demo-claude.cjs')
const env = { ...process.env, DRAGON_DEMO: '1', DRAGON_DEMO_PLAN: planPath, DRAGON_CLAUDE_BIN: fake, DRAGON_COPILOT_BIN: fake }
for (const arg of process.argv.slice(2)) {
  const m = /^--shot=(.+)$/.exec(arg)
  if (m) {
    env.DRAGON_SCREENSHOT = path.resolve(m[1])
    env.DRAGON_SCREENSHOT_DELAY = env.DRAGON_SCREENSHOT_DELAY || '9000'
  }
}
console.log(`Demo kingdom at ${demoRoot}`)
const electron = require('electron')
const child = spawn(electron, ['.', `--user-data-dir=${userData}`], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
