# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

Botalot's patrol uses the software factory's labels instead, defined in the `factory-labels` skill: it takes tickets labelled `factory:ready` + `factory:agent-owned`, holds them at `factory:in-progress` while a patrol dragon works (the label is the lock; don't add it by hand), and moves them to `factory:in-review` once that dragon opens a pull request. A ticket whose dragon dies twice is flagged `factory:agent-blocked`.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

