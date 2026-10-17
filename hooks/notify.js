// Claude Code hook forwarder. Reads the hook payload from stdin and posts it to the
// Botalot app over localhost. Never blocks Claude: exits 0 on any failure.
const http = require('http')

const port = Number(process.env.DRAGON_PORT || 0)
const dragonId = process.env.DRAGON_SESSION || ''
if (!port || !dragonId) process.exit(0)

// `--event <Name>` is passed from the hook config so camelCase payloads (Copilot CLI) are self-describing too.
const eventArg = (() => {
  const i = process.argv.indexOf('--event')
  return i !== -1 ? process.argv[i + 1] : undefined
})()

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
