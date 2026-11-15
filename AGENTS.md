## Working rule: make it deterministic

If a step can be a script with a pass/fail exit code, it is one. Run the script and report its output rather than judging the result by reading files.

Where scripts live:

- A script used by one of this repo's own skills lives inside that skill: `.claude/skills/<skill>/scripts/`.
- Any other script goes in `scripts/<concern>/` (e.g. `scripts/demo/`, `scripts/ci/`). No loose files directly in `scripts/`.
- Every repo-level script is run through an npm script in `package.json`.
- Never add or change files in vendored skills (below).

## Verifying work

`npm run verify` runs every deterministic check. Exit 0 = the work passes. New checks are added to this script, not run separately.

- Unit tests are `*.test.ts` files beside the code, run by Node's own test runner on the TypeScript as-is (`npm test`). Node resolves imports itself, so a tested module may import only with explicit `.ts` extensions, and nothing from `electron` or `node-pty`: keep logic worth testing in such a module. Node only strips types, so such modules also avoid `enum` and constructor parameter properties.

- Verifying is the last step of the work, before committing: run `npm run verify` and report its output. Work isn't finished, and isn't committed, until it passes.
- `verify` is for agents only. CI doesn't call it. `.github/workflows/ci.yml` runs on pushes to `main` and when a pull request is opened, updated or reopened, and calls each check as a reusable workflow (`on: workflow_call`), skipping a check when none of its inputs changed.
- A new check added to `verify` also needs its own reusable workflow called from `ci.yml`, and its inputs listed in `scripts/ci/changed-checks.cjs`. Preview which checks a change runs: `npm run ci:changes -- <base> <head>`.
- The Node major version is pinned in `.nvmrc`, and CI reads it from there.

## Packaging

`npm run dist` builds and packages a portable Windows exe into `dist/` (config: `electron-builder.yml`). The `build` workflow uploads it as the `botalot-windows` artifact.

- Shells started by VS Code set `ELECTRON_RUN_AS_NODE=1`, which makes any Electron exe exit at once. Clear it before launching the app from such a shell.

## Commits

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`, e.g. `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`). Rules come from `@commitlint/config-conventional`.

- Enforced on commit by the husky `commit-msg` hook (installed by `npm install`). Never bypass it with `--no-verify`.
- Verify: `npm run commits:check` (exit 0 = every commit not yet on `origin/main` passes).
- CI re-checks every push to `main` and every pull request (`.github/workflows/commitlint.yml`, called from `ci.yml`).

### Choosing the type

Pick the type by the change's effect on someone using Botalot, not by the files it touches. `feat` and `fix` are for **user-visible** changes only; everything else gets the type that names what it changes.

| Type | Use when | Example |
|---|---|---|
| `feat` | Users of the app see something new | a new dialog, new dragon behaviour |
| `fix` | Users of the app see a bug go away | a session that wouldn't spawn |
| `build` | Packaging, bundling or dependencies change | electron-builder config, swapping node-pty |
| `ci` | Only `.github/workflows/` changes | splitting CI into jobs |
| `chore` | Repo upkeep that affects neither the app nor its build | vendoring skills, commit hooks |
| `docs` | Only documentation changes, AGENTS.md included | this table |

When one commit spans several types, use the type of its main purpose: packaging the exe is `build`, even though it touched `src/` and CI along the way.

## Vendored skills

Skills in `.agents/skills/` (linked into `.claude/skills/`) come from `mattpocock/skills` via the `skills` CLI, pinned in `package.json` and recorded in `skills-lock.json`. Don't edit them; changes are overwritten by updates.

- Update: `npm run skills:update`

## Factory

This repo runs the software factory from `paigelester/skills`, installed as the `factory` Claude Code plugin (turned on in `.claude/settings.json`), not vendored. Its contract with the factory is `.factory/contract.json`: the stacks whose knowledge loads, the checks every change must pass, and which reviews a change gets.

- To implement a ticket, start its run with `factory start implement <ticket>` rather than doing the steps by hand. `factory next` carries a waiting run on.
- The contract's `commands.verify` is `npm run verify`, so a check added there is picked up by factory runs too.
- Change a factory skill, workflow or the driver in `paigelester/skills`, never here. Botalot only starts the driver and reads its run logs (`src/main/runs.ts`, `src/shared/runs.ts`).

## Agent skills

### Issue tracker

Issues live in GitHub Issues for paigelester/botalot (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
