# Botalot

A software factory for coding agents, in two parts:

- **The CLI** (`botalot`): workflows, step skills and knowledge, and the driver that runs them. Light, with no dependencies. This is what a repo installs.
- **The app** (`app/`): a fantasy command view on top, where every agent session is a dragon in your kingdom. Optional. See [app/README.md](app/README.md).

Claude Code and GitHub Issues only.

| Layer | Folder | Holds | Rule |
|---|---|---|---|
| Workflows | `workflows/` | `implement` | Owns order, gates and loop limits. Declares what a repo must provide. |
| Step skills | `skills/` | `build`, `review-code` | One job each. Never names the next step. |
| Driver | `bin/`, `cli/` | The `botalot` command: runs workflows, verify, contract check, labels, run log | No judgment. Pass or fail. |
| Knowledge | `knowledge/` | Fundamentals, stacks, review rubrics | How I write and judge code. Loaded into steps, never run. |

`skills/` also holds skills that have no workflow yet and are followed by hand: `create-tickets`, `route-ticket`, `fix-pr`, `merge-pr`, `notify`, `factory-labels`, `setup-factory`, `using-skills` and `clear-replies`.

## How a run works

The driver, not an agent, moves a run from step to step. It runs each skill step as a fresh headless Claude Code session, runs script steps itself, and checks every gate before the next step, so a step can't be skipped.

```
botalot start implement 12

claim     ticket must be factory:ready with an owner; moves it to in-progress; makes the branch
build     agent-owned: a fresh agent builds it.  human-owned: the run waits for you (`botalot next`)
verify    the driver runs the contract's checks and stamps a pass with the exact files it passed on
review    reviews picked from the changed files by the contract's rules, each a fresh agent
squash    the run's commits become one commit, with the repo's hooks running   (agent-owned)
pr        refused unless a verify pass is on record for exactly what is pushed  (agent-owned)
handoff   ticket moves to in-review, with the PR link
```

A failed check or a `must` review finding goes back to build, up to the workflow's loop limit. Then the run stops, flags the ticket `factory:needs-you` and says why in a comment. Agents never merge.

## Use it in a repo

1. **Install the CLI** as a dev dependency, pinned to a release:

   ```bash
   npm install --save-dev github:paigelester/botalot#v1.1.0
   ```

   `npm install` then brings it to any machine or cloud agent that works on the repo, and `npx botalot` runs it. A repo with no `package.json` gets a small one for this.

2. **Write the repo's contract**, `.factory/contract.json`. A workflow refuses to start unless the contract meets its needs:

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/paigelester/botalot/main/schemas/contract.schema.json",
     "botalot": "1.1.0",
     "stacks": ["typescript", "nextjs"],
     "commands": {
       "setup": ["npm install"],
       "verify": ["npm run lint", "npm run typecheck", "npm test", "npm run build"],
       "run": "npm run dev"
     },
     "workflows": ["implement"],
     "reviews": [{ "paths": ["app/**"], "run": ["code"] }],
     "limits": { "minutesPerRun": 60, "maxRuns": 2, "pauseAtQuotaPercent": 80 }
   }
   ```

   | Field | Means |
   |---|---|
   | `botalot` | The botalot version the repo targets. Its major.minor must match the installed one, so upgrading a repo is a deliberate step. |
   | `stacks` | Which `knowledge/stacks/` files load for build and review. |
   | `commands.setup` | Optional. Commands that get a fresh checkout ready for the checks, such as `npm install`. Run once when a run claims its ticket. |
   | `commands.verify` | Every check a change must pass. Only the driver's run of them counts. |
   | `workflows` | The workflows the repo turns on. |
   | `reviews` | Which reviews a change gets, by the paths it touches. A file no rule covers gets the `code` review. |
   | `limits` | Optional. Time per unattended run, runs at once, and the share of the 5-hour usage window at which unattended runs pause. |
   | `allow` | Optional. Extra shell commands an agent may run without asking. |
   | `mcp` | Optional. `true` lets agent steps load the machine's MCP servers. Off by default: they cost tokens on every step. |
   | `defaultBranch` | Optional. The branch work starts from and PRs target. |

3. **Check it and set up the labels:**

   ```bash
   npx botalot check
   npx botalot labels --fix
   ```

## Commands

```
botalot check [workflow]              Check this repo's contract
botalot start <workflow> <ticket>     Start a run for a ticket
botalot next [run]                    Carry on this repo's waiting run
botalot status [--all] [--json]       Show open runs (or every run)
botalot stop <run>                    End a run
botalot verify                        Run the contract's checks on the code as it is now
botalot labels [--fix] [--prune]      Compare the repo's labels with the factory's ten
botalot knowledge                     Print the knowledge this repo's contract loads
botalot list                          Show the workflows, reviews and stacks botalot has
```

## Run logs

Every run writes to `~/.botalot/runs/` (set `BOTALOT_HOME` to move it):

- `<run>.jsonl`: the run log. One JSON event per line, appended as things happen: each step's start and end, each agent's session id, duration, cost, tokens, tools and skills used, each check's exit code, each loop and wait. Every line carries the run, repo, ticket and workflow.
- `<run>.json`: the run's state, which `botalot next` carries on from.
- `<run>/`: each agent's prompt and answer, each check's full output, the review findings, the PR body.

Reopen any agent step with `claude --resume <session id>`. The app's runs panel reads the same files.

## Working on botalot

```bash
npm install          # repo tooling: commit hooks, commitlint
npm run hooks        # turn the commit hooks on, once per clone
npm run app:install  # the app's own dependencies

npm run verify       # everything: the CLI's checks and tests, then the app's
npm run verify:cli   # the CLI alone
npm run dev          # run the app
```

- **A rule I keep repeating:** add it to the right file in `knowledge/`. See `knowledge/README.md`.
- **A new stack:** add `knowledge/stacks/<name>.md`.
- **A new review:** add `knowledge/rubrics/<name>.md` and a `skills/review-<name>/` step skill (`SKILL.md` plus `step.json`).
- **A new skill:** add `skills/<name>/SKILL.md`. The frontmatter `name` must match the folder. Wrap the `description` in double quotes if it contains `: ` or ` #`.
- **A new workflow:** add `workflows/<name>.json`. See `workflows/README.md`.

The root `package.json` is the CLI's and must stay free of dependencies and of a `prepare` script: either would be installed or run in every repo that depends on botalot. Its `files` list is what those repos receive.

A release is a version bump in `package.json` and a `v<version>` tag. A minor or major bump means every repo's contract has to be updated before its workflows run again.
