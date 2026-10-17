// `npm run ci:changes -- <base> <head>`: decides which CI checks a change needs, from the files
// changed between two commits. Prints `<check>=true|false` per check, and also writes them to
// $GITHUB_OUTPUT when set, so ci.yml can skip checks whose inputs didn't change.
const { execFileSync } = require('child_process')
const fs = require('fs')

// Files every check depends on: the toolchain, and ci.yml itself.
const shared = ['package.json', 'package-lock.json', '.nvmrc', '.github/workflows/ci.yml']

// Each check's inputs. An entry ending in `/` matches everything under that folder.
const checks = {
  typecheck: ['src/', 'electron.vite.config.ts', 'tsconfig.json', '.github/workflows/typecheck.yml'],
  build: ['src/', 'hooks/', 'electron.vite.config.ts', 'electron-builder.yml', 'tsconfig.json', '.github/workflows/build.yml']
}

const matches = (file, entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)

/** Changed files, or null when they can't be worked out (e.g. the first push of a branch). */
function changedFiles(base, head) {
  if (!base || !head || /^0+$/.test(base)) return null
  try {
    return execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
  } catch {
    return null
  }
}

const [base, head] = process.argv.slice(2)
const files = changedFiles(base, head)
if (files === null) console.log('Changed files unknown; running every check.')

const lines = Object.entries(checks).map(([name, inputs]) => {
  const needed = files === null || files.some((f) => [...shared, ...inputs].some((entry) => matches(f, entry)))
  return `${name}=${needed}`
})

console.log(lines.join('\n'))
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n')
