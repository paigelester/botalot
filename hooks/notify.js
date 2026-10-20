// Claude Code hook forwarder. Reads the hook payload from stdin and posts it to the
// Botalot app over localhost. Never blocks Claude: exits 0 on any failure.
// Also serves as a dragon's status line command (`--event StatusLine`), so the app sees quota readings.
const http = require('http')
const fs = require('fs')
const { exec } = require('child_process')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

// Dragons in the app's pty get DRAGON_PORT and DRAGON_SESSION in their environment. Background dragons
// run under Claude Code's supervisor, which does not pass the environment on, so their hook config names
// a file holding the app's current port instead, and the app matches them by the payload's session_id.
const portFile = arg('--port-file')
let port = Number(process.env.DRAGON_PORT || 0)
let dragonId = process.env.DRAGON_SESSION || ''
if (!port && portFile) {
  try {
    port = Number(fs.readFileSync(portFile, 'utf8').trim())
  } catch {
    port = 0 // the app is not running
  }
  dragonId = ''
}
const canPost = !!port && (!!dragonId || !!portFile)

// `--event <Name>` is passed from the hook config so camelCase payloads (Copilot CLI) are self-describing too.
const eventArg = arg('--event')
// As a status line, the user's own status line command (base64), whose output is printed in our place.
const chain = arg('--chain') ? Buffer.from(arg('--chain'), 'base64').toString('utf8') : ''
if (!canPost && !chain) process.exit(0)

let pending = 0
function start() {
  pending++
}
function done() {
  if (--pending <= 0) process.exit(0)
}

function post(raw) {
  let payload = {}
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    payload = { raw }
  }
  if (eventArg && !payload.hook_event_name) payload.hook_event_name = eventArg
  const body = JSON.stringify({ dragonId, payload })
  start()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    done()
  }
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 1500
    },
    (res) => {
      res.resume()
      res.on('end', finish)
    }
  )
  req.on('error', finish)
  req.on('close', finish)
  req.on('timeout', () => req.destroy())
  req.end(body)
}

function runChain(raw) {
  start()
  const child = exec(chain, { timeout: 2500, windowsHide: true }, (_err, stdout) => {
    if (stdout) process.stdout.write(stdout, done)
    else done()
  })
  child.stdin.on('error', () => {})
  child.stdin.end(raw)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  start()
  if (canPost) post(raw)
  if (chain) runChain(raw)
  done()
})
setTimeout(() => process.exit(0), 3000).unref()
