import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Issue, PatrolSettings, Project } from '../shared/types.ts'
import type { RunView } from '../shared/runs.ts'
import { LABEL, Patrol, type PatrolTracker } from './patrol.ts'

/** A tracker in memory: issues with labels, and every comment written. */
class FakeTracker implements PatrolTracker {
  comments: { key: string; text: string }[] = []
  issues: (Issue & { createdAt: number })[]
  constructor(issues: (Issue & { createdAt: number })[]) {
    this.issues = issues
  }
  async ready() {
    return this.issues.filter((i) => i.labels.includes(LABEL.ready) && i.labels.includes(LABEL.agent)).sort((a, b) => a.createdAt - b.createdAt)
  }
  async relabel(key: string, remove: string[], add: string[]) {
    const i = this.find(key)
    i.labels = [...i.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !i.labels.includes(l))]
  }
  async comment(key: string, text: string) {
    this.comments.push({ key, text })
  }
  async ensureLabels() {}
  find(key: string) {
    const i = this.issues.find((x) => x.key === key)
    if (!i) throw new Error('no issue ' + key)
    return i
  }
}

const issue = (key: string, createdAt: number, labels: string[] = [LABEL.ready, LABEL.agent]) => ({ key, title: `Issue ${key}`, body: 'Do it.', labels, assignees: [], updatedAt: '', createdAt })

function realm(patrol: PatrolSettings = { enabled: true, max: 1 }): Project {
  return { id: 'r1', path: 'C:\\code\\repo', name: 'Repo', tint: 0, worktreeLayout: 'sibling', hidden: false, isGit: true, source: 'manual', tracker: { kind: 'github' }, patrol }
}

function run(ticket: number, over: Partial<RunView> = {}): RunView {
  return {
    id: `repo-${ticket}-x`,
    mainRepo: 'C:/code/repo',
    cwd: 'C:/code/repo-worktrees/x',
    repoName: 'repo',
    ticket,
    workflow: 'implement',
    owner: 'agent-owned',
    status: 'running',
    alive: true,
    branch: null,
    pr: null,
    waitReason: null,
    waitDetail: null,
    currentStep: 'build',
    startedAt: 0,
    updatedAt: 0,
    seconds: 0,
    cost: 0,
    steps: [],
    ...over
  }
}

/** Patrol wired to fakes. A started run stays "starting" until the test finishes it with `finish` or `fail`. */
function setup(issues: (Issue & { createdAt: number })[], project = realm()) {
  const tracker = new FakeTracker(issues)
  const runs: RunView[] = []
  const attempts = new Map<string, number>()
  const settled = new Set<string>()
  const started: { key: string; finish(): void; fail(why: string): void }[] = []
  const patrol = new Patrol({
    projects: () => [project],
    runs: () => runs,
    trackerFor: () => tracker,
    start: (_p, i) => new Promise<void>((resolve, reject) => started.push({ key: i.key, finish: resolve, fail: (why) => reject(new Error(why)) })),
    memory: { attempts: (k) => attempts.get(k) ?? 0, setAttempts: (k, n) => void attempts.set(k, n), settled: (id) => settled.has(id), settle: (id) => void settled.add(id) },
    log: () => {}
  })
  /** Let the promise chains patrol hung on a start settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { patrol, tracker, runs, started, attempts, settle }
}

test('starts a run for the oldest ready agent-owned ticket and leaves its labels to the driver', async () => {
  const { patrol, tracker, started } = setup([issue('7', 2), issue('3', 1), issue('9', 0, [LABEL.ready])])
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['3'])
  assert.deepEqual(tracker.find('3').labels, [LABEL.ready, LABEL.agent])
  assert.equal(tracker.comments.length, 0)
})

test('holds to the realm limit: a run that is starting or going takes a place, one resting on a human does not', async () => {
  const { patrol, runs, started, settle } = setup([issue('1', 1), issue('2', 2), issue('3', 3)])
  await patrol.tick()
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['1'], 'the first start holds the only place')

  runs.push(run(1))
  started[0].finish()
  await settle()
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['1'], 'its run is going, so the place is still held')

  runs[0] = run(1, { status: 'waiting-you', alive: false })
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['1', '2'], 'a run waiting on you frees the place, and #1 is not started again')
})

test('a realm that allows two starts two at once', async () => {
  const { patrol, started } = setup([issue('1', 1), issue('2', 2), issue('3', 3)], realm({ enabled: true, max: 2 }))
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['1', '2'])
})

test('a ticket that cannot be started is tried again, then handed to a human', async () => {
  const { patrol, tracker, started, settle } = setup([issue('5', 1)])
  await patrol.tick()
  started[0].fail('The contract does not pass:\n- .factory/contract.json is missing.')
  await settle()
  assert.deepEqual(tracker.find('5').labels, [LABEL.ready, LABEL.agent], 'still ready after one failure')

  await patrol.tick()
  started[1].fail('The contract does not pass:\n- .factory/contract.json is missing.')
  await settle()
  assert.deepEqual(tracker.find('5').labels, [LABEL.agent, LABEL.needsYou])
  assert.match(tracker.comments[0].text, /could not start a factory run[\s\S]*contract\.json is missing[\s\S]*factory:ready again/)

  await patrol.tick()
  assert.equal(started.length, 2, 'patrol leaves it alone until it is ready again')
})

test('a run that fell over is flagged on its ticket once', async () => {
  const { patrol, tracker, runs } = setup([issue('4', 1, [LABEL.agent, 'factory:in-progress'])])
  runs.push(run(4, { status: 'running', alive: false, currentStep: 'verify' }))
  await patrol.tick()
  await patrol.tick()
  assert.ok(tracker.find('4').labels.includes(LABEL.needsYou))
  assert.equal(tracker.comments.length, 1)
  assert.match(tracker.comments[0].text, /repo-4-x` lost its driver at the "verify" step[\s\S]*factory next repo-4-x/)
})

test('patrol ignores other realms, human-owned runs, and realms with patrol off', async () => {
  const off = setup([issue('1', 1)], realm({ enabled: false, max: 1 }))
  await off.patrol.tick()
  assert.equal(off.started.length, 0)

  const { patrol, tracker, runs, started } = setup([issue('1', 1)])
  runs.push(run(8, { mainRepo: 'C:/code/other', status: 'stopped' }), run(9, { owner: 'human-owned', status: 'stopped' }))
  await patrol.tick()
  assert.equal(tracker.comments.length, 0)
  assert.deepEqual(started.map((s) => s.key), ['1'])
})
