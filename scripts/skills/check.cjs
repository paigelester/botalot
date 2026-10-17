// `npm run skills:check`: verifies the vendored skills match skills-lock.json, so an agent can
// prove an install or update landed without reading the files. Uses the same folder hash as the
// `skills` CLI (sha256 over each file's relative path + content, sorted by path).
// Exits 1 and lists every problem if anything is off.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = path.join(__dirname, '..', '..')
const lockPath = path.join(root, 'skills-lock.json')
const canonicalDir = path.join(root, '.agents', 'skills')
const agentDirs = [path.join(root, '.claude', 'skills')]

function collectFiles(baseDir, currentDir, results) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name)
    const stat = fs.statSync(fullPath) // follows junctions and symlinks
    if (stat.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      collectFiles(baseDir, fullPath, results)
    } else if (stat.isFile()) {
      results.push({ relativePath: path.relative(baseDir, fullPath).split('\\').join('/'), content: fs.readFileSync(fullPath) })
    }
  }
}

function hashSkillFolder(dir) {
  const files = []
  collectFiles(dir, dir, files)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update(file.content)
  }
  return hash.digest('hex')
}

const problems = []
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
const locked = Object.keys(lock.skills).sort()

for (const name of locked) {
  const expected = lock.skills[name].computedHash
  const canonical = path.join(canonicalDir, name)
  if (!fs.existsSync(path.join(canonical, 'SKILL.md'))) {
    problems.push(`${name}: missing .agents/skills/${name}/SKILL.md`)
    continue
  }
  if (hashSkillFolder(canonical) !== expected) problems.push(`${name}: .agents/skills/${name} differs from skills-lock.json (edited locally or partial update)`)
  for (const agentDir of agentDirs) {
    const linked = path.join(agentDir, name)
    const label = path.relative(root, linked).split('\\').join('/')
    if (!fs.existsSync(linked)) problems.push(`${name}: missing ${label}`)
    else if (hashSkillFolder(linked) !== expected) problems.push(`${name}: ${label} differs from skills-lock.json`)
  }
}

// Only .agents/skills is fully CLI-managed; .claude/skills may also hold the repo's own skills.
for (const name of fs.readdirSync(canonicalDir)) {
  if (!lock.skills[name]) problems.push(`${name}: in .agents/skills but not in skills-lock.json`)
}

if (problems.length) {
  console.error(`skills:check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`skills:check ok: ${locked.length} skills match skills-lock.json`)
