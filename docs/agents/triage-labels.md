# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

Botalot's patrol uses the software factory's labels instead, defined in the `factory-labels` skill: it takes tickets labelled `factory:ready` + `factory:agent-owned` and starts a factory run for each. The run's driver moves the ticket to `factory:in-progress` when it claims it (don't add that label by hand) and to `factory:in-review` once it opens a pull request. A ticket whose run needs a person, or could not be started twice, is flagged `factory:needs-you`.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

