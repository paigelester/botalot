import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardCount, parseBoard, parseDue } from './board.ts'

test('a board is read from the CLI, dropping anything malformed', () => {
  const board = parseBoard({
    toApprove: [{ number: 12, title: 'Add it', url: 'u', owner: 'agent-owned', plan: '## Routing plan' }, { number: 13, title: 'No owner' }, 'junk'],
    needsYou: [{ number: 3, title: 'Stuck', url: 'u3' }],
    yoursToBuild: 'nope',
    inReview: [{ number: 4, title: 'PR', url: 'u4' }, { title: 'no number' }]
  })
  assert.ok(board)
  assert.deepEqual(board.toApprove, [{ number: 12, title: 'Add it', url: 'u', owner: 'agent-owned', plan: '## Routing plan' }])
  assert.deepEqual(board.needsYou, [{ number: 3, title: 'Stuck', url: 'u3' }])
  assert.deepEqual(board.yoursToBuild, [])
  assert.deepEqual(board.inReview, [{ number: 4, title: 'PR', url: 'u4' }])
  assert.equal(boardCount(board), 1)
  assert.equal(boardCount(undefined), 0)
})

test('output that is not a board is refused', () => {
  assert.equal(parseBoard({ error: 'The contract does not pass' }), null)
  assert.equal(parseBoard(null), null)
})

test('what is due is read from the CLI', () => {
  assert.deepEqual(parseDue([{ workflow: 'route', kind: 'planning', where: 'main', number: 12, title: 'T', url: 'u' }, { workflow: 'implement', number: 5, title: 'B', url: 'v' }, { number: 9 }]), [
    { workflow: 'route', kind: 'planning', where: 'main', number: 12, title: 'T', url: 'u' },
    { workflow: 'implement', kind: 'work', where: 'holding', number: 5, title: 'B', url: 'v' }
  ])
  assert.deepEqual(parseDue({}), [])
})
