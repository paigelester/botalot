import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRunView, formatDuration, isOpenRun, parseRunLog, runDragonState, runNeedsYou, toolSummary } from './runs.ts'

const state = {
  id: 'site-12-20261115-155153',
  workflow: 'implement',
  repo: 'C:/code/site-worktrees/12-add',
  mainRepo: 'C:/code/site',
  repoName: 'site',
  ticket: 12,
  owner: 'agent-owned',
  status: 'done',
  branch: '12-add',
  pr: 'https://github.com/x/site/pull/3',
  activeSeconds: 95,
  startedAt: '2026-11-15T15:51:53.000Z',
  updatedAt: '2026-11-15T15:53:30.000Z'
}

const log = [
  { event: 'run-start' },
  { event: 'step-start', step: 'claim' },
  { event: 'step-end', step: 'claim', outcome: 'passed', seconds: 2 },
  { event: 'step-start', step: 'build' },
  { event: 'agent', step: 'build', skill: 'build', session: 'aaa', seconds: 40, cost: 0.2, tokens: { input: 900, output: 50 }, model: 'm', tools: { Edit: 3, Bash: 1 }, skills: [], ok: true },
  { event: 'activity', step: 'build', text: 'Edit src/a.ts' },
  { event: 'step-end', step: 'build', outcome: 'passed', seconds: 41 },
  { event: 'step-start', step: 'verify' },
  { event: 'check', step: 'verify', command: 'npm test', exit: 1, seconds: 4 },
  { event: 'step-end', step: 'verify', outcome: 'failed', seconds: 4 },
  { event: 'loop', step: 'verify', to: 'build' },
  { event: 'step-start', step: 'build' },
  { event: 'agent', step: 'build', skill: 'build', session: 'bbb', seconds: 20, cost: 0.1, tools: { Edit: 1 }, skills: ['simplify'], ok: true },
  { event: 'step-end', step: 'build', outcome: 'passed', seconds: 21 },
  { event: 'step-start', step: 'verify' },
  { event: 'check', step: 'verify', command: 'npm test', exit: 0, seconds: 5 },
  { event: 'step-end', step: 'verify', outcome: 'passed', seconds: 5 },
  { event: 'step-skip', step: 'squash' }
]
  .map((e) => JSON.stringify(e))
  .join('\n')

test('a run view folds every round of a step together', () => {
  const run = buildRunView(state, parseRunLog(log), false)
  assert.ok(run)
  assert.deepEqual(
    run.steps.map((s) => `${s.id}:${s.outcome}:${s.rounds}`),
    ['claim:passed:1', 'build:passed:2', 'verify:passed:2', 'squash:skipped:0']
  )
  const build = run.steps[1]
  assert.equal(build.seconds, 62)
  assert.equal(build.agents.length, 2)
  assert.equal(build.agents[1].session, 'bbb')
  assert.deepEqual(build.agents[1].skills, ['simplify'])
  assert.ok(Math.abs(build.cost - 0.3) < 1e-9)
  assert.ok(Math.abs(run.cost - 0.3) < 1e-9)
  assert.deepEqual(run.steps[2].checks, [{ command: 'npm test', exit: 0, seconds: 5 }], 'only the latest round of checks is kept')
  assert.equal(run.mainRepo, 'C:/code/site')
  assert.equal(run.cwd, 'C:/code/site-worktrees/12-add')
  assert.equal(run.seconds, 95)
  assert.equal(run.pr, 'https://github.com/x/site/pull/3')
  assert.equal(toolSummary(build.agents), 'Edit 4 · Bash 1')
  assert.deepEqual(run.activity, [{ step: 'build', text: 'Edit src/a.ts' }])
})

test('a resting run says why, and at which step', () => {
  const waiting = { ...state, status: 'waiting-you', pr: undefined, wait: { step: 'verify', reason: 'Decision needed at the "verify" step.', detail: 'npm test failed' } }
  const run = buildRunView(waiting, [], false)
  assert.ok(run)
  assert.equal(run.currentStep, 'verify')
  assert.equal(run.waitReason, 'Decision needed at the "verify" step.')
  assert.equal(run.waitDetail, 'npm test failed')
  assert.ok(isOpenRun(run) && runNeedsYou(run))
})

test('a running run whose driver has gone is cut short and needs carrying on', () => {
  const events = parseRunLog(JSON.stringify({ event: 'step-start', step: 'build' }))
  const live = buildRunView({ ...state, status: 'running' }, events, true)
  const dead = buildRunView({ ...state, status: 'running' }, events, false)
  assert.equal(live?.steps[0].outcome, 'running')
  assert.equal(live?.currentStep, 'build')
  assert.equal(runNeedsYou(live!), false)
  assert.equal(dead?.steps[0].outcome, 'stopped')
  assert.equal(runNeedsYou(dead!), true)
})

test('files that are not runs, and broken log lines, are ignored', () => {
  assert.equal(buildRunView({ fiveHour: { usedPercent: 10 } }, [], false), null)
  assert.equal(buildRunView(null, [], false), null)
  assert.deepEqual(parseRunLog('{"event":"a"}\n{"event":"b"'), [{ event: 'a' }])
})

test('a run shows as a dragon: flying, waiting, resting or fallen', () => {
  const view = (over: object, alive = false) => buildRunView({ ...state, pr: undefined, ...over }, parseRunLog(JSON.stringify({ event: 'step-start', step: 'build' })), alive)!
  assert.deepEqual(runDragonState(view({ status: 'running' }, true)), { state: 'working', attention: 'Run: build' })
  assert.equal(runDragonState(view({ status: 'running' })).state, 'waiting', 'a run whose driver died needs you')
  assert.deepEqual(runDragonState(view({ status: 'waiting-human', wait: { step: 'build', reason: 'Your turn: build for #12.' } })), { state: 'waiting', attention: 'Your turn: build for #12.' })
  assert.equal(runDragonState(view({ status: 'paused-quota' })).state, 'idle')
  assert.deepEqual(runDragonState(view({ status: 'done', pr: 'https://x/pull/1' })), { state: 'idle', attention: 'Run done: pull request open' })
  assert.deepEqual(runDragonState(view({ status: 'stopped', stopped: 'Ticket #12 is closed.' })), { state: 'dead', attention: 'Ticket #12 is closed.' })
})

test('durations read at a glance', () => {
  assert.equal(formatDuration(42), '42s')
  assert.equal(formatDuration(185), '3m 05s')
  assert.equal(formatDuration(4320), '1h 12m')
})
