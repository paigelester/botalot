# Botalot

A software factory for coding agents, in two parts:

- **The CLI** (`botalot`): workflows, step skills and knowledge, and the driver that runs them. Light, with no dependencies. This is what a repo installs.
- **The app** (`app/`): a fantasy command view on top, where every agent session is a dragon in your kingdom. Optional. See [app/README.md](app/README.md).

Claude Code and GitHub Issues only.

| Layer | Folder | Holds | Rule |
|---|---|---|---|
| Workflows | `workflows/` | `implement`, `route`, `fix-pr` | Owns order, gates and loop limits. Declares what a repo must provide. |
| Step skills | `skills/` | `build`, `review-code`, `route`, `fix-pr` | One job each. Never names the next step. |
| Driver | `bin/`, `cli/` | The `botalot` command: runs workflows, verify, contract check, labels, run log | No judgment. Pass or fail. |
| Knowledge | `knowledge/` | Fundamentals, stacks, review rubrics | How I write and judge code. Loaded into steps, never run. |

`skills/` also holds skills that have no workflow yet and are followed by hand: `create-tickets`, `merge-pr`, `notify`, `factory-labels`, `setup-factory`, `using-skills` and `clear-replies`.

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

## Fixing a pull request

Once a pull request is open, `fix-pr` works it. A round takes on every failing check, every review thread whose last word isn't botalot's, and every comment on the pull request since botalot last answered.

```
botalot start fix-pr 12

collect   finds the ticket's open PR, gets onto its branch as pushed, lists what needs an answer
fix       a fresh agent gives every item a verdict (fixed, push-back, out-of-scope, nothing-to-do) and makes the fixes
verify    as in implement                                       (skipped when no code changed)
review    as in implement                                       (skipped when no code changed)
squash    the round's work becomes one new commit on top of the PR  (skipped when no code changed)
push      refused unless a verify pass is on record for exactly what is pushed
answer    a reply on every review thread, and one comment on the PR with what the round did
```

The driver holds the agent to its word: every item needs an answer, and `fixed` needs a changed file. Threads are answered, never resolved: that is yours. After three rounds on one pull request the next one asks first. The ticket stays `factory:in-review`, and merging stays with you.

## Planning, and the board

Not every workflow changes code. A workflow's `kind` is `work` or `planning`, and each can name the labels that make it due:

```
factory:refined                   on your board, to pick:  botalot pick 12   (or the oldest:  botalot pick)
factory:selected, no owner        route is due: an agent judges risk and solvability, the driver picks the owner
                                  by rule (agent when risk is low or medium and solvability is yes) and posts the plan
selected + owner                  on your board, to approve:  botalot approve 12   (selected becomes ready)
factory:ready + agent-owned       implement is due
factory:ready + human-owned       on your board, yours to build:  botalot start implement 12
in-review + agent-owned           fix-pr is due when its PR has a failed check or something unanswered,
                                  and no check still running
```

`botalot due` lists the runs that should be started; the app's patrol starts them. `botalot board` lists the tickets waiting on you.

## Use it in a repo

1. **Install the CLI** as a dev dependency, pinned to a release:

   ```bash
   npm install --save-dev github:paigelester/botalot#v1.2.0
   ```

   `npm install` then brings it to any machine or cloud agent that works on the repo, and `npx botalot` runs it. A repo with no `package.json` gets a small one for this.

2. **Set the repo up:**

   ```bash
   npx botalot setup
   ```

   It writes a first contract, `.factory/contract.json`, from what the repo already says about itself (its `package.json` scripts and dependencies), checks it, and creates the factory's labels on GitHub. It never overwrites a contract that is there. Read what it wrote and correct it: a workflow refuses to start unless the contract meets its needs.

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/paigelester/botalot/main/schemas/contract.schema.json",
     "botalot": "1.2.0",
     "stacks": ["typescript", "nextjs"],
     "commands": {
       "setup": ["npm install"],
       "verify": ["npm run lint", "npm run typecheck", "npm test", "npm run build"],
       "run": "npm run dev"
     },
     "workflows": ["implement", "route", "fix-pr"],
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

3. **Confirm the checks pass on a clean checkout**, then commit the contract:

   ```bash
   npx botalot verify
   ```

## Commands

```
botalot setup [--no-labels]           Set this repo up: write its contract if it has none, and its labels
botalot check [workflow]              Check this repo's contract
botalot start <workflow> <ticket>     Start a run for a ticket
botalot next [run]                    Carry on this repo's waiting run
botalot status [--all] [--json]       Show open runs (or every run)
botalot stop <run>                    End a run
botalot verify                        Run the contract's checks on the code as it is now
botalot labels [--fix] [--prune]      Compare the repo's labels with the factory's ten
botalot knowledge [--index|--write]   Print the knowledge this repo's contract loads; or its index; or write the index
botalot skill <name> [--ticket <n>]   Try one step skill by itself, to test it. Add --dry to only print its prompt
botalot board [--json]                Show the tickets waiting on you
botalot pick [ticket]                 Pick a refined ticket to work on: refined becomes selected
botalot approve <ticket>              Approve a routed ticket: selected becomes ready
botalot due [--json]                  Show the runs that should be started
botalot list                          Show the workflows, reviews and stacks botalot has
```

## Knowledge in ordinary sessions

Inside a run, the driver hands each step the knowledge files it needs. In an ordinary Claude Code session, nothing is loaded up front. Instead `botalot setup` (or `botalot knowledge --write`) puts a short index in the repo's `CLAUDE.md`: one line per knowledge file, with a label saying when to read it. The session opens a file only when the task fits its label.

The index lists the fundamentals and the stacks the contract names. It is only written when botalot is installed inside the repo, so its paths work on every machine. Run `botalot knowledge --write` again after changing the contract's stacks or upgrading botalot.

## Testing a skill

Work goes through workflows. To try one step skill by itself while you are changing it:

```bash
botalot skill build --ticket 12 --dry    # print the exact prompt the agent would get
botalot skill review-code --ticket 12    # run it against the repo as it is now
```

It gets the same prompt, knowledge and permissions as in a run, but nothing around it happens: no ticket is claimed or labelled, nothing is committed, and no gate runs.

## Run logs

Every run writes to `~/.botalot/runs/` (set `BOTALOT_HOME` to move it):

- `<run>.jsonl`: the run log. One JSON event per line, appended as things happen: each step's start and end, each agent's session id, duration, cost, tokens, tools and skills used, what an agent is doing as it does it, each check's exit code, each loop and wait. Every line carries the run, repo, ticket and workflow.
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
- **A new stack:** add `knowledge/stacks/<name>.md`, with a `when:` label in its frontmatter.
- **A new review:** add `knowledge/rubrics/<name>.md` and a `skills/review-<name>/` step skill (`SKILL.md` plus `step.json`).
- **A new skill:** add `skills/<name>/SKILL.md`. The frontmatter `name` must match the folder. Wrap the `description` in double quotes if it contains `: ` or ` #`.
- **A new workflow:** add `workflows/<name>.json`. See `workflows/README.md`.

The root `package.json` is the CLI's and must stay free of dependencies and of a `prepare` script: either would be installed or run in every repo that depends on botalot. Its `files` list is what those repos receive.

A release is a version bump in `package.json` and a `v<version>` tag. A minor or major bump means every repo's contract has to be updated before its workflows run again.
