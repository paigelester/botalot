---
name: route
description: Score one selected ticket's risk and whether an agent can finish it alone, so its owner (agent or human) can be picked. Use as the route step of a botalot run, or when asked to plan, route, triage for owner or assess risk on a ticket.
---

# Route

You judge one ticket so its builder can be chosen. You end with a short approach, a risk rating and a solvability rating, each with its reasons, or with one question for the human. You read; you change nothing. The driver picks the owner from your ratings, posts the plan on the ticket and adds the owner label.

## Steps

1. **Check it's buildable.** The ticket needs a purpose and acceptance criteria that are checkable statements. If it has neither, or a criterion can't be checked without guessing what the human wants, stop and ask. A parent ticket is never built itself: say so and stop. Done when every criterion is checkable.
2. **Read the code.** Read the repo's `CLAUDE.md` or `AGENTS.md`, its glossary, any decision records the ticket touches, and the code each criterion will change. Done when you can name every area of the code the change touches.
3. **Sketch the approach.** In a few lines, outline how the change could be made, only enough to judge risk and solvability. Done when you can score both from it.
4. **Score risk.** Rate it `low`, `medium` or `high`, with one line per reason. High when it touches data, security, auth, payments, a public API or anything users can't undo, or when the change spans many areas. Low when it's contained, covered by tests and easy to revert. If the ticket already states a risk and you disagree, say so and why. Done when the rating has its reasons.
5. **Score solvability.** Rate whether an agent can finish it alone: `yes`, `partly` or `no`. It drops for each thing only a human has: a secret, a service or an account the agent can't reach, a design or taste judgment (visual, UX, wording), hardware or a device, or a decision the ticket leaves open. Name each one. Done when the rating has its reasons.
6. **Answer.** Report in the required shape.

## Answer

- `status`: `done`, or `needs-human` when you stopped to ask.
- `approach`: the outline, a few short lines.
- `risk` and `riskReasons`.
- `solvability` and `solvabilityReasons` (use "nothing only a human has" when it is `yes`).
- `areas`: each area of the code touched, in the glossary's words.
- `kind` and `question`: only with `needs-human`.

Do not name an owner. The rule is the driver's: an agent owns it when risk is low or medium and solvability is yes; a human otherwise.

## Stop and ask

When the ticket isn't buildable, answer `needs-human` with `kind: decision` and one question: what the missing criterion should be, or whether to refine the ticket further, with your recommended answer.
