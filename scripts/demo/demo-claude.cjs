// Stand-in for the `claude` binary used by demo mode (DRAGON_DEMO=1) and tests.
// It walks through the hook events a real session would send, so dragons change state,
// and echoes anything typed into its terminal.
const { spawn } = require('child_process')
const path = require('path')

const scenario = process.env.DRAGON_DEMO_SCENARIO || 'quest'
const hook = path.join(__dirname, '..', '..', 'hooks', 'notify.js')

function send(payload) {
  return new Promise((resolve) => {
    const p = spawn('node', [hook], { env: process.env, stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('exit', resolve)
    p.stdin.end(JSON.stringify({ session_id: 'demo-' + process.pid, ...payload }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

process.stdout.write('\x1b[1;33mDemo dragon\x1b[0m standing in for claude. Args: ' + process.argv.slice(2).join(' ') + '\r\n')
process.stdout.write('Type and it echoes. Ctrl+C exits.\r\n\r\n')
process.stdin.setRawMode?.(true)
process.stdin.resume()
// Set while the waiting scenario asks for permission: Enter answers it, as it would a real prompt.
let awaitingAnswer = false
process.stdin.on('data', (d) => {
  if (d[0] === 3) process.exit(0)
  process.stdout.write(d)
  if (awaitingAnswer && d.includes(13)) {
    awaitingAnswer = false
    void (async () => {
      process.stdout.write('\r\nAnswered. Running npm test...\r\n')
      await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
      await sleep(1500)
      await send({ hook_event_name: 'Stop' })
      process.stdout.write('Quest complete. Resting.\r\n')
    })()
  }
})

;(async () => {
  await send({ hook_event_name: 'SessionStart', source: 'startup' })
  await sleep(500)
  if (scenario === 'idle') {
    await send({ hook_event_name: 'Stop' })
    return
  }
  if (scenario === 'busy') {
    // Keeps questing: a tool call every few seconds, forever, so the dragon stays in the air.
    await send({ hook_event_name: 'UserPromptSubmit', prompt: 'demo' })
    const tools = ['Read', 'Grep', 'Edit', 'Bash']
    let n = 0
    for (;;) {
      const tool = tools[n++ % tools.length]
      await send({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} })
      process.stdout.write('\x1b[2m[' + tool + ']\x1b[0m working on step ' + n + '...\r\n')
      await sleep(2500 + Math.random() * 2000)
      await send({ hook_event_name: 'PostToolUse', tool_name: tool })
    }
  }
  if (scenario === 'hang') {
    // Starts a tool and never hears back: the app should flag it as stuck.
    await send({ hook_event_name: 'UserPromptSubmit', prompt: 'demo' })
    await send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'deliver --all' } })
    process.stdout.write('\x1b[2m[Bash]\x1b[0m deliver --all ...\r\n')
    return
  }
  if (scenario === 'rename') {
    // Pretend the draft conversation finished: file the issue and rename the branch, as a real dragon would.
    await send({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await sleep(2500)
    const { execFileSync } = require('child_process')
    const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['branch', '-m', current, '77-shaped-idea'])
    process.stdout.write('\r\nRenamed branch ' + current + ' -> 77-shaped-idea\r\n')
    await send({ hook_event_name: 'Stop' })
    return
  }
  await send({ hook_event_name: 'UserPromptSubmit', prompt: 'demo' })
  process.stdout.write('Questing...\r\n')
  await sleep(3000)
  await send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  if (scenario === 'waiting') {
    await sleep(500)
    await send({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    process.stdout.write('\r\n\x1b[33mAllow Bash(npm test)? (y/n)\x1b[0m ')
    awaitingAnswer = true
    return
  }
  if (scenario === 'dead') {
    await sleep(1000)
    process.exit(1)
  }
  await sleep(2000)
  await send({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  await sleep(2000)
  await send({ hook_event_name: 'Stop' })
  process.stdout.write('Quest complete. Resting.\r\n')
})()
