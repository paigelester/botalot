# Workflows

A workflow is a JSON file the driver (`botalot`) runs one step at a time. It owns the order, the gates and the loop limits. Step skills and scripts know nothing about what comes next.

```json
{
  "name": "implement",
  "needs": ["commands.verify"],
  "steps": [{ "id": "verify", "script": "verify", "onFail": "build", "maxLoops": 5 }]
}
```

| Field | Means |
|---|---|
| `kind` | `work` (changes code; a dragon in the app) or `planning` (decides things; a goblin, and its result goes on the realm's board) |
| `where` | `holding` (a worktree of its own) or `main` (the repo's main checkout, for a run that only reads) |
| `trigger` | Optional. The labels a ticket must have (`labels`) and must not have (`without`) for the run to be due. `botalot due` lists what is due; the app's patrol starts it |
| `needs` | Dot paths that must be filled in the repo's `.factory/contract.json`, or the workflow refuses to start |
| `steps[].id` | The step's name in the run log |
| `steps[].script` | A script step: plain code in `cli/lib/driver.mjs`, no agent |
| `steps[].skill` | A skill step: `skills/<name>/` run as a fresh agent |
| `steps[].then` | A script that runs on the agent's answer, straight after a skill step |
| `steps[].human` | The owner label for which a person does this step instead (`human-owned`) |
| `steps[].only` | The owner label this step is for; skipped otherwise |
| `steps[].onFail` | The step to go back to when this one fails |
| `steps[].maxLoops` | How many times this step may fail before the run stops and asks |

## Workflows

- `implement`: claim → build → verify → review → squash → PR → hand-off. Due when a ticket is ready and agent-owned.
- `route`: select → route → post the plan and owner label. Due when a ticket is selected and has no owner. The human approves the result (`botalot approve`).
