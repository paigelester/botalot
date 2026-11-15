import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PatrolSettings, Project } from '../shared/types.ts'
import type { Due } from '../shared/board.ts'
import type { RunView } from '../shared/runs.ts'
import { LABEL, Patrol, type PatrolTracker } from './patrol.ts'

/** A tracker in memory: every label change and comment patrol makes. */
class FakeTracker implements PatrolTracker {
  comments: { key: string; text: string }[] = []
  added = new Map<string, string[]>()
  async relabel(key: string, _remove: string[], add: string[]) {
    this.added.set(key, [...(this.added.get(key) ?? []), ...add])
  }
  async comment(key: string, text: string) {
    this.comments.push({ key, text })
  }
  async ensureLabels() {}
}

const implement = (number: number): Due => ({ workflow: 'implement', kind: 'work', where: 'holding', number, title: `Issue ${number}`, url: '' })
const route = (number: number): Due => ({ workflow: 'route', kind: 'planning', where: 'main', number, title: `Issue ${number}`, url: '' })

function realm(patrol: PatrolSettings = { enabled: true, max: 1 }): Project {
  return { id: 'r1', path: 'C:\\code\\repo', name: 'Repo', tint: 0, worktreeLayout: 'sibling', hidden: false, isGit: true, source: 'manual', tracker: { kind: 'github' }, patrol }
}

function run(ticket: number, over: Partial<RunView> = {}): RunView {
  return {
    id: `repo-${ticket}-x`,
    kind: 'work',
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
    activity: [],
    ...over
  }
}

/** Patrol wired to fakes. A started run stays "starting" until the test finishes it with `finish` or `fail`. */
function setup(due: Due[], project = realm()) {
  const tracker = new FakeTracker()
  const runs: RunView[] = []
  const attempts = new Map<string, number>()
  const settled = new Set<string>()
  const started: { key: string; finish(): void; fail(why: string): void }[] = []
  const patrol = new Patrol({
    projects: () => [project],
    runs: () => runs,
    trackerFor: () => tracker,
    due: async () => due,
    start: (_p, d) => new Promise<void>((resolve, reject) => started.push({ key: `${d.workflow} ${d.number}`, finish: resolve, fail: (why) => reject(new Error(why)) })),
    memory: { attempts: (k) => attempts.get(k) ?? 0, setAttempts: (k, n) => void attempts.set(k, n), settled: (id) => settled.has(id), settle: (id) => void settled.add(id) },
    log: () => {}
  })
  /** Let the promise chains patrol hung on a start settle. */
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { patrol, tracker, runs, started, due, settle }
}

test('starts the first run that is due, whatever its workflow, and leaves the ticket to the driver', async () => {
  const { patrol, tracker, started } = setup([route(3), implement(7)])
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['route 3'])
  assert.equal(tracker.added.size, 0)
  assert.equal(tracker.comments.length, 0)
})

test('holds to the realm limit: a run that is starting or going takes a place, one resting on a human does not', async () => {
  const { patrol, runs, started, due, settle } = setup([implement(1), implement(2)])
  await patrol.tick()
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['implement 1'], 'the first start holds the only place')

  runs.push(run(1))
  due.shift() // a ticket with an open run is no longer due
  started[0].finish()
  await settle()
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['implement 1'], 'its run is going, so the place is still held')

  runs[0] = run(1, { status: 'waiting-you', alive: false })
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['implement 1', 'implement 2'], 'a run waiting on you frees the place')
})

test('a realm that allows two starts two at once', async () => {
  const { patrol, started } = setup([route(1), implement(2), implement(3)], realm({ enabled: true, max: 2 }))
  await patrol.tick()
  assert.deepEqual(started.map((s) => s.key), ['route 1', 'implement 2'])
})

test('a ticket that cannot be started is tried again, then flagged for a human', async () => {
  const { patrol, tracker, started, settle } = setup([implement(5)])
  await patrol.tick()
  started[0].fail('git worktree add failed')
  await settle()
  assert.equal(tracker.added.size, 0, 'nothing is flagged after one failure')

  await patrol.tick()
  started[1].fail('git worktree add failed')
  await settle()
  assert.deepEqual(tracker.added.get('5'), [LABEL.needsYou])
  assert.match(tracker.comments[0].text, /could not start a implement run[\s\S]*git worktree add failed[\s\S]*remove the factory:needs-you label/)
})

test('a run that fell over is flagged on its ticket once', async () => {
  const { patrol, tracker, runs } = setup([])
  runs.push(run(4, { status: 'running', alive: false, currentStep: 'verify' }))
  await patrol.tick()
  await patrol.tick()
  assert.deepEqual(tracker.added.get('4'), [LABEL.needsYou])
  assert.equal(tracker.comments.length, 1)
  assert.match(tracker.comments[0].text, /repo-4-x` lost its driver at the "verify" step[\s\S]*botalot next repo-4-x/)
})

test('patrol ignores other realms, human-owned runs, and realms with patrol off', async () => {
  const off = setup([implement(1)], realm({ enabled: false, max: 1 }))
  await off.patrol.tick()
  assert.equal(off.started.length, 0)

  const { patrol, tracker, runs, started } = setup([implement(1)])
  runs.push(run(8, { mainRepo: 'C:/code/other', status: 'stopped' }), run(9, { owner: 'human-owned', status: 'stopped' }))
  await patrol.tick()
  assert.equal(tracker.comments.length, 0)
  assert.deepEqual(started.map((s) => s.key), ['implement 1'])
})
