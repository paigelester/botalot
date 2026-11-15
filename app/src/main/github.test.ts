import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ciStatus } from './github.ts'

const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion })
const ctx = (state: string) => ({ __typename: 'StatusContext', state })

test('no checks reported', () => {
  assert.equal(ciStatus([]), 'none')
  assert.equal(ciStatus(null), 'none')
})

test('every check finished well, skipped and neutral included, passes', () => {
  assert.equal(ciStatus([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), run('COMPLETED', 'NEUTRAL'), ctx('SUCCESS')]), 'pass')
})

test('an unfinished check is pending', () => {
  assert.equal(ciStatus([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')]), 'pending')
  assert.equal(ciStatus([run('QUEUED')]), 'pending')
  assert.equal(ciStatus([ctx('PENDING')]), 'pending')
  assert.equal(ciStatus([ctx('EXPECTED')]), 'pending')
})

test('any failure fails, even while others still run', () => {
  assert.equal(ciStatus([run('IN_PROGRESS'), run('COMPLETED', 'FAILURE')]), 'fail')
  for (const c of ['TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) assert.equal(ciStatus([run('COMPLETED', c)]), 'fail', c)
  assert.equal(ciStatus([ctx('ERROR')]), 'fail')
  assert.equal(ciStatus([ctx('FAILURE')]), 'fail')
})
