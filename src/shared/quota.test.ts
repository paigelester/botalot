import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentQuota, formatReset, parseRateLimits } from './quota.ts'

const H = 3_600_000

test('reads both windows, converting resets_at from epoch seconds', () => {
  const q = parseRateLimits({
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } }
  })
  assert.deepEqual(q, { fiveHour: { usedPercent: 23.5, resetsAt: 1738425600_000 }, sevenDay: { usedPercent: 41.2, resetsAt: 1738857600_000 } })
})

test('a window may be absent on its own', () => {
  assert.deepEqual(parseRateLimits({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 10 } } }), { sevenDay: { usedPercent: 5, resetsAt: 10_000 } })
})

test('no quota without rate_limits or a usable window', () => {
  assert.equal(parseRateLimits({}), null)
  assert.equal(parseRateLimits({ rate_limits: null }), null)
  assert.equal(parseRateLimits({ rate_limits: {} }), null)
  assert.equal(parseRateLimits({ rate_limits: { five_hour: { used_percentage: '12', resets_at: 10 } } }), null)
  // A spend limit behind a gateway is not a subscription window.
  assert.equal(parseRateLimits({ rate_limits: { spend_limit: { used_percentage: 50, resets_at: 10 } } }), null)
})

test('percentages are clamped to 0..100', () => {
  assert.equal(parseRateLimits({ rate_limits: { five_hour: { used_percentage: 130, resets_at: 10 } } })?.fiveHour?.usedPercent, 100)
})

test('a window is dropped once its reset time passes', () => {
  const q = { fiveHour: { usedPercent: 90, resetsAt: 2 * H }, sevenDay: { usedPercent: 40, resetsAt: 100 * H } }
  assert.deepEqual(currentQuota(q, 1 * H), q)
  assert.deepEqual(currentQuota(q, 3 * H), { sevenDay: q.sevenDay })
  assert.equal(currentQuota(q, 200 * H), null)
  assert.equal(currentQuota(null, 0), null)
})

test('reset times read at a glance', () => {
  assert.equal(formatReset(42 * 60_000, 0), 'in 42m')
  assert.equal(formatReset(10_000, 0), 'in 1m')
  assert.equal(formatReset(3 * H + 5 * 60_000, 0), 'in 3h 5m')
  assert.equal(formatReset(52 * H, 0), 'in 2d 4h')
})
