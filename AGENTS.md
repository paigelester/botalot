## Working rule: make it deterministic

If a step can be a script with a pass/fail exit code, it is one. Run the script and report its output rather than judging the result by reading files.

Where scripts live:

- A script used by one of this repo's own skills lives inside that skill: `.claude/skills/<skill>/scripts/`.
- Any other script goes in `scripts/<concern>/` (e.g. `scripts/demo/`, `scripts/skills/`). No loose files directly in `scripts/`.
- Every repo-level script is run through an npm script in `package.json`.
- Never add or change files in vendored skills (below).

## Verifying work

`npm run verify` runs every deterministic check (typecheck, skills check). Exit 0 = the work passes. New checks are added to this script, not run separately.

- Verifying is the last step of the work, before committing: run `npm run verify` and report its output. Work isn't finished, and isn't committed, until it passes.
- CI runs it again on pushes to `main` and when a pull request is opened, updated or reopened (`.github/workflows/ci.yml`).

## Commits

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`, e.g. `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). Rules come from `@commitlint/config-conventional`.

- Enforced on commit by the husky `commit-msg` hook (installed by `npm install`). Never bypass it with `--no-verify`.
- Verify: `npm run commits:check` (exit 0 = every commit not yet on `origin/main` passes).
- CI re-checks pushes to `main` and pull requests (`.github/workflows/ci.yml`).

## Vendored skills

Skills in `.agents/skills/` (linked into `.claude/skills/`) come from `mattpocock/skills` via the `skills` CLI, pinned in `package.json`. Don't edit them; changes are overwritten by updates and fail the check.

- Update: `npm run skills:update` (updates, then runs the check)
- Verify: `npm run skills:check` (exit 0 = every skill matches its hash in `skills-lock.json`)

## Agent skills

### Issue tracker

Issues live in GitHub Issues for paigelester/botalot (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
