import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nameFor } from './names.ts'

test('a seed always gets the same real name, and similar seeds spread over many names', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => `site-${i}-20261115-190000`)
  const names = seeds.map(nameFor)
  for (const n of names) assert.equal(typeof n, 'string')
  assert.deepEqual(names, seeds.map(nameFor))
  assert.ok(new Set(names).size > 30, `only ${new Set(names).size} different names`)
})
