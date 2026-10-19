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

**Wild dragon**:
A Claude Code background session the app did not summon, discovered through `claude agents --json`. The app shows and attaches to it but never records, slays or wakes it.
_Avoid_: External session, foreign dragon

**Unclaimed lands**:
The camp where wild dragons gather when their folder lies outside every realm.
