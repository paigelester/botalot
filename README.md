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
- **Awaiting you.** The "awaiting you" pill in the top bar (or Ctrl+Shift+A) opens
  a list of every waiting dragon, longest-waiting first, with what it needs. Type a
  quick reply and press Enter to send it to the dragon's terminal, or Open it.
  Background dragons have no terminal of the app's own, so they are answered by
  opening them. The waiting count also shows as a badge on the taskbar icon, and
  when a dragon starts waiting while the window is not focused, an OS notification
  says so; clicking it opens that dragon.
- **Patrol.** Switch on Patrol for a realm in the Realms dialog and, every couple
  of minutes while the app runs, it takes the oldest open ticket labelled both
  `factory:ready` and `factory:agent-owned`, moves it to `factory:in-progress`, and
  summons a background dragon (marked ⚑) on a new holding named from the ticket,
  told to work unattended with the `implement-ticket` skill: build, verify, review
  and open a pull request. When that branch has a PR, the ticket becomes
  `factory:in-review`. If the dragon falls first, the ticket goes back to
  `factory:ready` for one more try, then gets flagged `factory:agent-blocked`, with a
  comment each time. A dragon that needs a decision or access flags the ticket
  itself (`factory:agent-awaiting-human` / `factory:agent-blocked`) and says why in
  a comment. The factory skills and labels come from `paigelester/skills`; see
  [Factory skills](#factory-skills). At most
  N patrol dragons per realm at once (default 1). Works with GitHub (labels via
  `gh`) and Jira (labels via its API); pull requests are found with `gh` either
  way. Attempt counts live in `patrol.json` in the config folder.
  Patrol dragons work unattended, so they accept file edits and run the realm's
  allowed commands without asking (by default the checks, `git add/commit/push`
  and `gh` for issues and PRs; edit the list under the realm in Realms). Any other
  command waits for you and shows up as awaiting you. The ticket text becomes the
  dragon's instructions, so label only tickets you have read `factory:ready`.
  Realms that saved their own allow list before the factory labels need
  `gh issue edit *` and `gh issue comment *` added (or press Reset to defaults in Realms).
- **Pull requests.** In a realm whose tracker is GitHub, every holding with a
  dragon shows its branch's pull request under the signpost: `PR #142` with a CI
  dot (green passed, gold running, red failed, grey no checks), or `draft`,
  `merged` or `closed`. Click it to open the PR in your browser. The app asks
  `gh pr view <branch>` once a minute, one holding at a time, and again when a
  dragon on that branch goes idle. Without `gh`, or logged out, holdings simply
  show no sign.
- **Stuck dragons.** The app flags a dragon as stuck when it has been working with
  no hook event for 10 minutes (no terminal output, for agents without hooks), or
  waiting on you for more than 15. It gets a red ring, the panel says why, and it
  moves to the top of the awaiting-you list. It clears on the next sign of life.
  Change the limits in `config.json` in the app's config folder:
  `"stuck": { "workingQuietMinutes": 10, "waitingMinutes": 15 }`.
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
- **Background dragons.** Tick **Background** when summoning a Claude dragon and the
  app runs `claude --bg --name <dragon> "<quest>"` in the chosen folder instead of
  a terminal of its own, so the dragon keeps working after Botalot quits. It is
  tracked by the same poll as wild dragons, plus hooks: the background worker does
  not inherit the app's environment, so its hook settings
  (`dragon-hooks-background.json`) tell `hooks/notify.js` to read the app's current
  port from the `hook-port` file in the config folder, and events are matched by
  session id. Click it to attach; **Slay** runs `claude stop`, **Bury** runs
  `claude rm`. On relaunch it comes back live. If its session is gone, it falls,
  and waking it resumes the conversation in the app's own terminal.

## Factory skills

Patrol dragons follow the software factory's skills, installed from
[paigelester/skills](https://github.com/paigelester/skills) into `.agents/skills/`
(linked into `.claude/skills/`) by the `skills` CLI and recorded in `skills-lock.json`:

- `setup-factory`: sets up a realm's GitHub repo for the factory (its `factory:*` labels).
- `factory-labels`: the `factory:*` ticket labels and how to move a ticket between them.
- `implement-ticket`: one agent-owned ticket from `factory:ready` to an open pull request.
- `review-implementation`: the independent review of an implementation, by an agent or a developer, that `implement-ticket` runs in a subagent. Use it on a human-owned ticket too, before opening the PR.

    npm run skills:update                   # pull the latest skills
    npm run factory:setup -- owner/repo     # set up a realm's GitHub repo (add --check first to only report)

To use patrol in another realm, install the same skills there
(`npx skills add paigelester/skills --skill setup-factory --skill factory-labels --skill implement-ticket --skill review-implementation`).

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
