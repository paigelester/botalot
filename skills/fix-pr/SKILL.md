---
name: fix-pr
description: Answer everything open on one factory pull request (failing checks, review threads, comments) by fixing it in the working tree or saying why not. Use as the fix step of a botalot fix-pr run, or when asked to fix or address feedback on a pull request whose branch is already checked out.
---

# Fix a PR

You are the author of the pull request. You are given a list of items: failing checks, review threads and comments. You end with every item answered, and every fix made in the working tree, or with one question for the human. You don't commit, push, reply on GitHub or resolve threads: the driver does that with your answers.

## Steps

1. **Understand.** Read the ticket's acceptance criteria and the change so far (`git diff` against the commit you were given). For each failing check, read its log (`gh run view <run-id> --log-failed`, with the run id from the check's page address) and write the failure in one line. Done when you can say what every item asks for.
2. **Sort each item.** Each item gets one verdict:
   - `fixed`: it is in the ticket's scope and it is right. You will change the code.
   - `push-back`: you disagree, and can say why in one line from the ticket, the code or the repo's rules.
   - `out-of-scope`: it asks for work the ticket doesn't cover. Say so and suggest a follow-up ticket. Don't build it.
   - `nothing-to-do`: it asks for nothing, such as a thank you, or a check that failed for a reason outside the code and passes when run again.
   An item only a human can settle is not a verdict: stop and ask.
   Done when every item has one verdict.
3. **Fix.** Make the smallest change that resolves each `fixed` item, following the knowledge you were given and the repo's rules. Add a test where the item is a bug. Keep every acceptance criterion met. Done when every `fixed` item has code that resolves it.
4. **Check your own work.** Run the checks you were told the driver runs, and fix what fails. The driver runs them again and only its result counts. Done when they pass, or you have fixed what you can.
5. **Answer.** Report in the required shape. Done when every item id appears once with its verdict and reply.

When you are given **Rework**, an earlier attempt failed a gate. Fix exactly what it lists and answer the same way, with every item again.

## Answer

- `status`: `done`, or `needs-human` when you stopped to ask.
- `summary`: what this round changed and why, in one or two sentences. Empty when nothing changed.
- `commitMessage`: one line in the repo's commit style for this round's fixes. Leave it out when nothing changed.
- `items`: one entry for every item you were given, with its `id`, its `verdict`, and a `reply`: one or two sentences to the person who raised it, saying what you changed or why you didn't. Write the reply to stand alone; the driver adds the commit.
- `kind` and `question`: only with `needs-human`.

## Stop and ask

Stop as soon as an item needs something only a human has, and answer `needs-human`:

- `kind: decision`: two reviewers disagree, a comment changes what the ticket asks for, or a trade-off nobody has settled. Ask one question and give your recommended answer.
- `kind: blocked`: a secret, a service, a permission, or a command you aren't allowed to run. Name exactly what is missing.

Leave the work you have done in the working tree.
