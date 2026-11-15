---
name: setup-factory
description: Set up a repo so factory workflows can run in it (its `.factory/contract.json` and the `factory:*` labels on GitHub). Use after installing botalot in a repo, when `botalot check` fails, or when a botalot skill finds a label missing.
---

# Setup factory

You end with the repo ready for the factory: a contract that passes `botalot check`, and every `factory:*` label in place on GitHub. Only GitHub Issues is supported.

Run every `botalot` command from the repo being set up (`npx botalot` when it is installed as a dev dependency).

## Steps

1. **Run setup.** Run `botalot setup`. It writes a first `.factory/contract.json` from the repo's own scripts if there is none, checks it, and creates the labels. Done when you have its output.
2. **Correct the contract.** Setup's draft is a start, not the answer. Check each field against the repo itself, never from guesses:
   - `botalot`: the installed version (`botalot --help` prints it).
   - `stacks`: the stacks the repo uses, from the names `botalot list` prints.
   - `commands.verify`: every check a change must pass (lint, format check, type check, tests, build), read from the repo's `package.json` scripts, `Makefile` or CI workflow. Run each one and keep only commands that exist and exit 0 on a clean checkout. If one fails on a clean checkout, tell the human instead of leaving it out quietly.
   - `commands.run`: the command that runs the app, if there is one.
   - `workflows`: the workflows to turn on, from `botalot list`.
   - `reviews`: which reviews a change gets by the paths it touches, using only the reviews `botalot list` prints.

   Add `"$schema"` pointing at botalot's `schemas/contract.schema.json` for editor help. Done when `botalot check` passes and `botalot verify` passes on a clean checkout.
3. **Set up the labels.** Run `botalot labels`. If it reports missing labels, run `botalot labels --fix`, which creates missing labels and corrects out-of-date ones. If it stopped on `gh` sign-in or Issues being off, tell the human the exact fix and stop. Done when it reports no missing labels.
4. **Report.** Say the repo is ready, what the contract turns on, and what was set. If `botalot labels` listed retired labels, say so and that `botalot labels --prune` deletes them: that takes them off every ticket, so it is the human's call. Done when the human has those lines.

The labels and what they mean are in the `factory-labels` skill.
