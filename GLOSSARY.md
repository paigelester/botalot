# Botalot

A software factory for coding agents (the CLI), with a fantasy command view on top (the app): sessions are dragons, projects are castles.

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
A realm's setting that starts the runs that are due on its own: routing a selected ticket, implementing a ready, agent-owned one.
_Avoid_: Auto-pickup, dispatcher, routine

**Run**:
One pass of a workflow over a ticket, moved step by step by the driver, not by the app. Stands on the map as one run dragon for the whole run, and is listed in the runs panel.
_Avoid_: Job, pipeline, quest

**Run dragon**:
The dragon that stands for a run, at the run's holding, marked ⚑ with its ticket. It has no terminal: a run's agent steps are headless, so its panel shows the run's steps and activity. Each finished agent step can be opened as an ordinary dragon.
_Avoid_: Patrol dragon

**Goblin**:
The bookkeeper that stands for a planning run (routing a ticket, say) at its realm's castle, where a dragon stands for work. It writes while the run works, waves with the gold ring when the run needs you, and leaves when the run is done: the result is on the board.
_Avoid_: Planner, scribe

**Board**:
A realm's tickets that wait on you, grouped by what they need: to approve, needs you, yours to build, in review. Opened by tapping the castle, which shows how many wait for approval.
_Avoid_: Inbox, queue, backlog

**Driver**:
The part of the `botalot` CLI that runs a run's steps, checks its gates and writes its log. The app starts it and reads what it writes.
_Avoid_: Runner, orchestrator

**Wild dragon**:
A Claude Code background session the app did not summon, discovered through `claude agents --json`. The app shows and attaches to it but never records, slays or wakes it.
_Avoid_: External session, foreign dragon

**Unclaimed lands**:
The camp where wild dragons gather when their folder lies outside every realm.
