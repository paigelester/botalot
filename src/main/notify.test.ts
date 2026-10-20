import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dirname, '..', '..', 'hooks', 'notify.js')

/** Runs hooks/notify.js with `stdin`; returns its stdout once it exits. */
function run(args: string[], stdin: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('error', reject)
    child.on('exit', () => resolve(out))
    child.stdin.end(stdin)
  })
}

/** A stand-in for the app's hook server: collects what is posted to it. */
async function server(): Promise<{ port: number; posts: unknown[]; close(): void }> {
  const posts: unknown[] = []
  const s = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      posts.push(JSON.parse(body))
      res.statusCode = 204
      res.end()
    })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as AddressInfo).port, posts, close: () => s.close() }
}

const READING = JSON.stringify({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } } })

test('as a status line, posts the reading tagged StatusLine', async () => {
  const srv = await server()
  try {
    const out = await run(['--event', 'StatusLine'], READING, { DRAGON_PORT: String(srv.port), DRAGON_SESSION: 'd1' })
    assert.equal(out, '')
    assert.deepEqual(srv.posts, [
      { dragonId: 'd1', payload: { session_id: 's1', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } }, hook_event_name: 'StatusLine' } }
    ])
  } finally {
    srv.close()
  }
})

test("prints the user's own status line, fed the same input", async () => {
  const srv = await server()
  const own = `node -e "process.stdin.on('data', d => process.stdout.write('mine:' + JSON.parse(d).session_id))"`
  try {
    const out = await run(['--event', 'StatusLine', '--chain', Buffer.from(own).toString('base64')], READING, {
      DRAGON_PORT: String(srv.port),
      DRAGON_SESSION: 'd1'
    })
    assert.equal(out, 'mine:s1')
    assert.equal(srv.posts.length, 1)
  } finally {
    srv.close()
  }
})

test("still prints the user's status line when the app is not running", async () => {
  const own = `node -e "process.stdout.write('mine')"`
  const out = await run(['--event', 'StatusLine', '--port-file', join(import.meta.dirname, 'no-such-port-file'), '--chain', Buffer.from(own).toString('base64')], READING, {
    DRAGON_PORT: '',
    DRAGON_SESSION: ''
  })
  assert.equal(out, 'mine')
})
