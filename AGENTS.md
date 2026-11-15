## Working rule: make it deterministic

If a step can be a script with a pass/fail exit code, it is one. Run the script and report its output rather than judging the result by reading files.

Where scripts live:

- A script used by one of this repo's own skills lives inside that skill: `.claude/skills/<skill>/scripts/`.
- Any other script goes in `scripts/<concern>/` (e.g. `scripts/ci/`), or `app/scripts/<concern>/` when it is the app's (e.g. `app/scripts/demo/`). No loose files directly in `scripts/`.
- Every repo-level script is run through an npm script in `package.json`.
- Never add or change files in vendored skills (below).

## Verifying work

`npm run verify` runs every deterministic check: the CLI's (`npm run verify:cli`), then the app's (`npm run verify:app`). Exit 0 = the work passes. New checks are added to this script, not run separately.

- The app's unit tests are `*.test.ts` files beside the code in `app/src/`, run by Node's own test runner on the TypeScript as-is. The CLI's tests are `tests/*.test.mjs`, run against a real git repo with a fake GitHub and a fake agent. Node resolves imports itself, so a tested module may import only with explicit `.ts` extensions, and nothing from `electron` or `node-pty`: keep logic worth testing in such a module. Node only strips types, so such modules also avoid `enum` and constructor parameter properties.

- Verifying is the last step of the work, before committing: run `npm run verify` and report its output. Work isn't finished, and isn't committed, until it passes.
- `verify` is for agents only. CI doesn't call it. `.github/workflows/ci.yml` runs on pushes to `main` and when a pull request is opened, updated or reopened, and calls each check as a reusable workflow (`on: workflow_call`), skipping a check when none of its inputs changed.
- A new check added to `verify` also needs its own reusable workflow called from `ci.yml`, and its inputs listed in `scripts/ci/changed-checks.cjs` (app paths start with `app/`). Preview which checks a change runs: `npm run ci:changes -- <base> <head>`.
- The Node major version is pinned in `.nvmrc`, and CI reads it from there.

## Packaging

`npm run dist` builds and packages a portable Windows exe into `app/dist/` (config: `app/electron-builder.yml`). The CLI is copied beside the app, so the exe can start runs with no Node installed. The `build` workflow uploads it as the `botalot-windows` artifact.

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

## The CLI and the app

This repo is two things. The root is the botalot CLI: the driver (`bin/`, `cli/`), workflows, step skills and knowledge, with its tests in `tests/`. `app/` is the Electron app, with its own `package.json`.

- The root `package.json` must stay free of dependencies and of a `prepare` script: either would be installed or run in every repo that depends on botalot. Repo tooling goes in its `devDependencies`; anything the app needs goes in `app/package.json`.
- The CLI is plain Node (`.mjs`, no build step, no dependencies). The app only starts the CLI and reads its run logs (`app/src/main/runs.ts`, `app/src/shared/runs.ts`); run logic never goes in the app.
- This repo is also a realm that runs its own workflows. Its contract is `.factory/contract.json`. To implement a ticket, start its run with `node bin/botalot.mjs start implement <ticket>` rather than doing the steps by hand; `node bin/botalot.mjs next` carries a waiting run on.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for paigelester/botalot (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

<!-- BEGIN:botalot-knowledge -->

## How code is written and judged here

Before writing or reviewing code, read each file below whose label fits the task. They are short. This repo's own rules overrule them.

- Making any code change: `knowledge/fundamentals/changes.md`
- Writing or restructuring code: `knowledge/fundamentals/clean-code.md`
- Handling errors or checking input: `knowledge/fundamentals/errors.md`
- Writing or changing tests: `knowledge/fundamentals/testing.md`
- Writing TypeScript: `knowledge/stacks/typescript.md`

This block is written by `botalot knowledge --write`. Change the rules in botalot, not here.

<!-- END:botalot-knowledge -->
