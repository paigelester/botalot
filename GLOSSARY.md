# Botalot

A fantasy command view over many coding-agent sessions: sessions are dragons, projects are castles.

## Language

**Realm**:
A project folder registered with the app, drawn as a castle.
_Avoid_: Project (in UI text), repo

**Holding**:
A git worktree of a realm, drawn as a small tower near its castle.
_Avoid_: Worktree (in UI text)

**Dragon**:
One coding-agent session shown on the map.
_Avoid_: Agent, bot

**Background dragon**:
A dragon whose session runs under Claude Code's background supervisor (`claude --bg`) rather than in the app's own terminal, so it outlives the app. Summoned by the app, so recorded, slain and buried by it.
_Avoid_: Detached dragon, daemon

**Patrol**:
A realm's setting that picks up tickets labelled `factory:ready` and `factory:agent-owned` on its own and starts a run to implement each.
_Avoid_: Auto-pickup, dispatcher, routine

**Run**:
One pass of a factory workflow over a ticket, moved step by step by the factory's driver (the `factory` command), not by the app. Shown in the runs panel; each agent step of a run can be opened as a dragon.
_Avoid_: Job, pipeline, quest

**Driver**:
The `factory` command from `paigelester/skills`. It runs a run's steps, checks its gates and writes its log; the app starts it and reads what it writes.
_Avoid_: Runner, orchestrator

**Wild dragon**:
A Claude Code background session the app did not summon, discovered through `claude agents --json`. The app shows and attaches to it but never records, slays or wakes it.
_Avoid_: External session, foreign dragon

**Unclaimed lands**:
The camp where wild dragons gather when their folder lies outside every realm.
