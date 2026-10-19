# Botalot

A fantasy-themed command view for running many coding-agent sessions at once,
Claude Code and GitHub Copilot CLI side by side.
Every session is a dragon. Every project is a castle. Every git worktree is a
small holding near its castle. Click a dragon to open its real terminal.

## Run it

    npm install
    npm run dev        # hot-reloading development window
    npm run build      # production bundle into out/
    npm start          # run the production bundle

Requires Node 20+, git, and at least one agent on PATH: `claude` (Claude Code)
or `copilot` (GitHub Copilot CLI, `npm i -g @github/copilot`, then `copilot login`). Windows is the primary target
(ConPTY via node-pty); it should also run on macOS and Linux.

## How it works

- **Realms** are discovered from `~/.claude/projects` (every folder you have run
  Claude Code in) and can be added or hidden in the Realms dialog.
- **Summon dragon** spawns `claude` in a pseudo-terminal in the chosen folder.
  Pick the castle (the repo folder as it is), an existing worktree, or a new one.
  A new holding fetches origin and branches from the latest remote default branch
  (falling back to local HEAD without a remote), in a sibling folder
  `<repo>-worktrees/<name>`, configurable per realm. Name it from an open issue in
  the realm's tracker (branch `<key>-<slug>`, issue text as the opening prompt),
  type a name, or start a **draft** named after the dragon and let the
  dragon file the issue and rename its own branch later; the map follows the
  rename.
- **Issue trackers** are chosen per realm in the Realms dialog: GitHub issues
  (via the gh CLI; inferred automatically when origin is on github.com), Jira,
  or none. Jira credentials are stored per site, encrypted with the OS
  (Electron safeStorage, DPAPI on Windows) in the app's config folder; a realm
  points at a site plus a project key, with optional custom JQL. The issue picker
  filters the 100 most recently updated open issues as you type and can search
  the tracker itself when more exist.
- **Agents.** Each dragon is either Claude Code or GitHub Copilot; pick when you
  summon. Copilot dragons carry a small star after their name.
- **State** comes from agent hooks. Claude sessions are started with
  `--settings <generated file>` so the hooks apply only to dragons. Copilot CLI
  has no per-session flag, so the app writes one user-level hooks file,
  `~/.copilot/hooks/botalot.json` (or under `COPILOT_HOME`); it is inert
  outside the app because `hooks/notify.js` exits at once without `DRAGON_PORT`.
  Both agents post the same events (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, PermissionRequest, Stop, SessionEnd, errors, notifications) to the
  app on localhost. Claude Code's live session registry (`~/.claude/sessions`) is
  a fallback when hooks are quiet, and if an agent sends no hooks at all the app
  falls back to watching terminal output: output means working, silence means
  idle, a y/n-style prompt means waiting.
- **Dragons survive restarts.** Every dragon is recorded the moment it is
  summoned (sessions.json in the app config folder) and kept current as its
  branch or agent session id changes. Quitting the app stops the processes but
  keeps the records, so on the next launch the dragons return faded and dormant.
  Wake one and the agent resumes its own session in the same folder, with the
  same conversation (`claude --resume` / `copilot --resume`). Bury forgets it.
- **Dragon states**: flying with fire = working; landed with a gold ring and
  exclamation = waiting on you (permission prompt or question); curled asleep =
  idle; faded and curled = dormant (from an earlier run, wake to resume); grey
  with a gravestone = exited (wake to resume, or bury).
- **Wild dragons** are Claude Code background sessions the app did not summon
  (`claude --bg`, `/bg`, the `claude agents` view). The app polls
  `claude agents --json --all` every few seconds and shows each one, with a green
  italic name, in the realm whose folder holds its `cwd`, or at the camp in the
  **unclaimed lands** when no realm does. Blocked sessions show the gold ring with
  what they wait for. Clicking one runs `claude attach <id>` in the panel; closing
  the panel closes only that client, and the session keeps running. Wild dragons
  are never recorded, slain or woken by the app; Claude Code's supervisor owns them.

## Pixel-art dragons

The dragon sprites in `src/renderer/public/assets/dragons/` were generated with
PixelLab (base pose plus fly, roar, idle and sleep clips) and are tinted per realm
at runtime. Replace or extend them by editing `manifest.json` there; each animation
is a strip or a list of frame files. Delete the manifest to fall back to the vector
placeholder dragon.

## Demo

    npm run demo

A self-contained show kingdom: five fictional realms are created as throwaway git
repos with worktrees under your temp folder, the app runs with its own config so
your real kingdom is untouched, and fake dragons (Claude and Copilot, castles and
holdings, every state including dormant) fill the map. Add `-- --shot=out.png` to
capture a screenshot and exit.

Other dev switches: `DRAGON_CLAUDE_BIN` / `DRAGON_COPILOT_BIN` override the agent
binaries, `DRAGON_SCREENSHOT=path.png` captures the window after a delay and quits,
`DRAGON_DEMO=1` alone summons a few fake dragons into your real realms.

## Layout

    src/main       Electron main: sessions (pty), projects, git, hook server, registry watcher
    src/preload    contextBridge API exposed as window.dragon
    src/renderer   React UI; scene/ is the PixiJS kingdom, panel/ is the terminal side panel
    src/shared     Types shared across processes
    hooks/         notify.js, the Claude Code hook forwarder
    scripts/       grouped by concern: demo/ (scripted kingdom + fake claude), skills/ (vendored-skill check)
