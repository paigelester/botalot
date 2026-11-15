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
A realm's setting that picks up tickets labelled `factory:ready` and `factory:agent-owned` on its own and summons a dragon to implement each.
_Avoid_: Auto-pickup, dispatcher, routine

**Patrol dragon**:
A background dragon patrol summoned for an issue. Marked ⚑.

**Wild dragon**:
A Claude Code background session the app did not summon, discovered through `claude agents --json`. The app shows and attaches to it but never records, slays or wakes it.
_Avoid_: External session, foreign dragon

**Unclaimed lands**:
The camp where wild dragons gather when their folder lies outside every realm.
