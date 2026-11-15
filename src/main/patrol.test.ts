import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Issue, PatrolMark, PatrolSettings, Project, PullRequestInfo, Session, SpawnRequest } from '../shared/types.ts'
import { LABEL, Patrol, type PatrolTracker } from './patrol.ts'
import { DEFAULT_PATROL_ALLOW } from '../shared/patrol.ts'

/** A tracker in memory: issues with labels, and every comment written. */
class FakeTracker implements PatrolTracker {
  comments: { key: string; text: string }[] = []
  issues: (Issue & { createdAt: number })[]
  constructor(issues: (Issue & { createdAt: number })[]) {
    this.issues = issues
  }
  async oldestReady() {
    const ready = this.issues.filter((i) => i.labels.includes(LABEL.ready) && i.labels.includes(LABEL.agent)).sort((a, b) => a.createdAt - b.createdAt)
    return ready[0] ?? null
  }
  async labels(key: string) {
    return [...this.find(key).labels]
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
  return { id: 'r1', path: '/repo', name: 'Repo', tint: 0, worktreeLayout: 'sibling', hidden: false, isGit: true, source: 'manual', tracker: { kind: 'github' }, patrol }
}

/** Patrol wired to fakes. Dragons it summons start working; tests then change their state or give them PRs. */
function setup(issues: (Issue & { createdAt: number })[], project = realm()) {
  const tracker = new FakeTracker(issues)
  const dragons: Session[] = []
  const prs = new Map<string, PullRequestInfo>()
  const attempts = new Map<string, number>()
  const summons: SpawnRequest[] = []
  let failSummon: string | null = null
  const patrol = new Patrol({
    projects: () => [project],
    sessions: () => dragons,
    trackerFor: () => tracker,
    pullRequest: async (_repo, branch) => prs.get(branch) ?? null,
    summon: async (req) => {
      summons.push(req)
      if (failSummon) throw new Error(failSummon)
      const s: Session = {
        id: 'd' + dragons.length,
        name: 'Dragon' + dragons.length,
        agent: 'claude',
        projectId: req.projectId,
        cwd: '/wt',
        branch: req.target.kind === 'new' ? req.target.branch : '',
        isWorktree: true,
        state: 'working',
        stateSince: 0,
        startedAt: 0
      }
      dragons.push(s)
      return s
    },
    mark: (id: string, mark: PatrolMark) => {
      const s = dragons.find((d) => d.id === id)!
      s.patrol = mark
    },
    attempts: { get: (k) => attempts.get(k) ?? 0, set: (k, n) => attempts.set(k, n) },
    log: () => {}
  })
  return { patrol, tracker, dragons, prs, summons, failSummon: (msg: string | null) => (failSummon = msg) }
}

test('takes the oldest ready agent-owned ticket: relabels it, summons a background dragon on its branch, marks the dragon', async () => {
  const t = setup([issue('9', 2), issue('4', 1), issue('7', 3, ['bug']), issue('2', 0, [LABEL.ready, 'factory:human-owned'])])
  await t.patrol.tick()
  assert.equal(t.summons.length, 1)
  const req = t.summons[0]
  assert.equal(req.background, true)
  assert.deepEqual(req.allow, DEFAULT_PATROL_ALLOW)
  assert.equal(req.agent, 'claude')
  assert.deepEqual(req.target, { kind: 'new', branch: '4-issue-4' })
  assert.match(req.prompt ?? '', /GitHub issue #4/)
  assert.match(req.prompt ?? '', /implement-ticket skill on #4/)
  assert.deepEqual(t.tracker.find('4').labels, [LABEL.agent, LABEL.working])
  assert.deepEqual(t.tracker.find('2').labels, [LABEL.ready, 'factory:human-owned'], 'human-owned tickets are left alone')
  assert.deepEqual(t.dragons[0].patrol, { issueKey: '4', issueUrl: undefined })
})

test("uses the realm's own allow list when it has one", async () => {
  const t = setup([issue('1', 1)], realm({ enabled: true, max: 1, allow: ['dotnet test'] }))
  await t.patrol.tick()
  assert.deepEqual(t.summons[0].allow, ['dotnet test'])
})

test('keeps to the realm cap', async () => {
  const t = setup([issue('1', 1), issue('2', 2), issue('3', 3)], realm({ enabled: true, max: 2 }))
  await t.patrol.tick()
  await t.patrol.tick()
  await t.patrol.tick()
  assert.equal(t.summons.length, 2)
  assert.deepEqual(t.tracker.find('3').labels, [LABEL.ready, LABEL.agent])
})

test('does nothing when patrol is off', async () => {
  const t = setup([issue('1', 1)], realm({ enabled: false, max: 1 }))
  await t.patrol.tick()
  assert.equal(t.summons.length, 0)
})

test('skips an issue another patrol already took', async () => {
  const t = setup([issue('1', 1, [LABEL.ready, LABEL.agent, LABEL.working])])
  await t.patrol.tick()
  assert.equal(t.summons.length, 0)
})

test('a pull request moves the ticket to in-review and frees the slot for the next one', async () => {
  const t = setup([issue('1', 1), issue('2', 2)])
  await t.patrol.tick()
  t.prs.set('1-issue-1', { number: 10, url: 'https://example/pull/10', state: 'OPEN', draft: true, ci: 'pending' })
  await t.patrol.tick()
  assert.deepEqual(t.tracker.find('1').labels, [LABEL.agent, LABEL.review])
  assert.equal(t.dragons[0].patrol?.settled, 'done')
  assert.match(t.tracker.comments[0].text, /pull\/10/)
  assert.equal(t.summons.length, 2, 'the next issue is taken in the same round')
  assert.deepEqual(t.tracker.find('2').labels, [LABEL.agent, LABEL.working])
})

test('a dragon that dies is retried once, then the ticket is flagged agent-blocked', async () => {
  const t = setup([issue('1', 1)])
  await t.patrol.tick()
  t.dragons[0].state = 'dead'
  await t.patrol.tick()
  assert.equal(t.dragons[0].patrol?.settled, 'retried')
  assert.equal(t.summons.length, 2, 'retried in the same round')
  assert.deepEqual(t.tracker.find('1').labels, [LABEL.agent, LABEL.working])

  t.dragons[1].state = 'dead'
  await t.patrol.tick()
  assert.equal(t.dragons[1].patrol?.settled, 'human')
  assert.deepEqual(t.tracker.find('1').labels, [LABEL.agent, LABEL.working, LABEL.blocked])
  assert.equal(t.summons.length, 2, 'no third attempt')
  assert.equal(t.tracker.comments.length, 2)
  assert.match(t.tracker.comments[1].text, /factory:agent-blocked/)
})

test('a failed summon counts as an attempt and puts the label back', async () => {
  const t = setup([issue('1', 1)])
  t.failSummon('Workspace not trusted')
  await t.patrol.tick()
  assert.deepEqual(t.tracker.find('1').labels, [LABEL.agent, LABEL.ready])
  assert.match(t.tracker.comments[0].text, /Workspace not trusted/)
})
