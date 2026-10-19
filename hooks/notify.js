// Claude Code hook forwarder. Reads the hook payload from stdin and posts it to the
// Botalot app over localhost. Never blocks Claude: exits 0 on any failure.
const http = require('http')
const fs = require('fs')

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
    process.exit(0) // the app is not running
  }
  dragonId = ''
}
if (!port || (!dragonId && !portFile)) process.exit(0)

// `--event <Name>` is passed from the hook config so camelCase payloads (Copilot CLI) are self-describing too.
const eventArg = arg('--event')

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let payload = {}
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    payload = { raw }
  }
  if (eventArg && !payload.hook_event_name) payload.hook_event_name = eventArg
  const body = JSON.stringify({ dragonId, payload })
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
      res.on('end', () => process.exit(0))
    }
  )
  req.on('error', () => process.exit(0))
  req.on('timeout', () => {
    req.destroy()
    process.exit(0)
  })
  req.end(body)
})
setTimeout(() => process.exit(0), 3000).unref()
