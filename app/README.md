# Botalot

A fantasy-themed command view for running many Claude Code sessions at once.
Every session is a dragon. Every project is a castle. Every git worktree is a
small holding near its castle. Click a dragon to open its real terminal.

## Run it

    npm install
    npm run dev        # hot-reloading development window
    npm run build      # production bundle into out/
    npm start          # run the production bundle

Requires Node 20+, git, and `claude` (Claude Code) on PATH. Windows is the primary target
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
  (via the gh CLI; inferred automatically when origin is on github.com) or none.
  The issue picker
  filters the 100 most recently updated open issues as you type and can search
  the tracker itself when more exist.
- **State** comes from agent hooks. Claude sessions are started with
  `--settings <generated file>` so the hooks apply only to dragons.
  They post their events (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, PermissionRequest, Stop, SessionEnd, notifications) to the
  app on localhost. Claude Code's live session registry (`~/.claude/sessions`) is
  a fallback when hooks are quiet, and if an agent sends no hooks at all the app
  falls back to watching terminal output: output means working, silence means
  idle, a y/n-style prompt means waiting.
- **Dragons survive restarts.** Every dragon is recorded the moment it is
  summoned (sessions.json in the app config folder) and kept current as its
  branch or agent session id changes. Quitting the app stops the processes but
  keeps the records, so on the next launch the dragons return faded and dormant.
  Wake one and the agent resumes its own session in the same folder, with the
  same conversation (`claude --resume`). Bury forgets it.
- **Awaiting you.** The "awaiting you" pill in the top bar (or Ctrl+Shift+A) opens
  a list of every waiting dragon, longest-waiting first, with what it needs. Type a
  quick reply and press Enter to send it to the dragon's terminal, or Open it.
  Background dragons have no terminal of the app's own, so they are answered by
  opening them. The waiting count also shows as a badge on the taskbar icon, and
  when a dragon starts waiting while the window is not focused, an OS notification
  says so; clicking it opens that dragon.
- **Runs.** The "runs" pill in the top bar (or Ctrl+Shift+R) opens every
  run of the driver (the `botalot` CLI at the root of this repo), the ones that
  need you first. Each run shows its ticket, where it is, and every step with its
  duration, its weight (what it would have cost at API prices), the tools and
  skills its agent used, and the checks it ran. Click a step's session to open
  it as a dragon in the run's folder, resuming where the step left off
  (`claude --resume`). **Carry on** runs `botalot next` for a run that is
  resting on you; **Stop** ends one. Botalot holds no run logic: it reads the
  driver's run logs in `~/.botalot/runs/`, so runs started from a terminal show
  up too.
- **Run dragons.** Every run in a realm stands on the map as one dragon for the
  whole run, at the run's holding, marked ⚑ with its ticket. It flies while a
  step is working, gets the gold ring when the run needs you (your own build
  step on a human-owned ticket, a question, a check that keeps failing, or a
  driver that died), rests once the run is done and falls if it stopped. It
  counts in "awaiting you", the badge and notifications like any dragon. Its
  panel has no terminal, because a run's agent steps are headless: it shows the
  run's steps, a live feed of what the agent and the checks are doing, and
  **Carry on**, **Stop** and **Summon a dragon here**. A finished run's dragon
  leaves after 12 hours, or when you bury it; the run stays in the runs panel.
  To start a run yourself, pick an issue for a new holding in the Summon dialog
  and tick **Run the implement workflow**.
- **Goblins and the board.** Planning is not building, so it looks different. A
  planning run (the route workflow) is a goblin bookkeeper at the realm's castle:
  writing while it works, waving with the gold ring if it needs you, gone when it
  is done. Its result lands on the realm's **board**, which a tap on the castle
  opens: tickets **to approve** (routed, with the plan and who builds it;
  **Approve** runs `botalot approve`), tickets that **need you**, tickets that
  are **yours to build** (**Start run**), and tickets **in review**. The castle
  shows how many wait for approval, and they count in "awaiting you". Summoning a
  dragon moved from the castle tap to a button on the board; the top bar's
  Summon dragon is unchanged.
- **Patrol.** Switch on Patrol for a realm, on its board or in the Realms dialog, and, every couple
  of minutes while the app runs, it starts the runs that are due there. What is
  due is the CLI's answer (`botalot due`): each ticket whose labels match the
  trigger of a workflow the realm's contract turns on, oldest first. A ticket
  labelled `factory:selected` with no owner gets a **route** run in the realm's
  main checkout; a ticket labelled `factory:ready` and `factory:agent-owned`
  gets an **implement** run in a holding named from the ticket. The driver does
  the rest: routing posts the plan and the owner label and leaves the ticket for
  you to approve; implementing moves the ticket to `factory:in-progress`, builds,
  verifies, reviews, opens the pull request and moves it to `factory:in-review`.
  A run that needs a decision or access flags the ticket `factory:needs-you`
  itself and says why in a comment. Patrol flags the ticket the same way when a
  run stops on a problem or loses its driver, and when no run could be started
  at all twice in a row; a flagged ticket is not due again until you remove the
  flag. A realm whose contract doesn't pass has nothing due, so patrol does
  nothing there. At most N runs per realm at once
  (default 1); a run resting on you doesn't hold a place. A run keeps going when
  Botalot quits. What an agent may do unattended is set by the step
  skills and the realm's contract, not here. The ticket text becomes the agent's
  instructions, so label only tickets you have read `factory:ready`. Labels are
  read and changed with `gh`; patrol's memory lives in `patrol.json` in the
  config folder.
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

## The CLI

Runs and patrol are driven by the botalot CLI at the root of this repo: its
workflows, step skills and knowledge, and the driver that runs them. The app
starts the CLI and shows what it logs. A realm that installs botalot as a dev
dependency is driven by its own pinned copy; any other realm by the copy that
ships with the app. The packaged exe runs the CLI itself, so it needs no Node.

A realm can run a workflow only once it has a contract, `.factory/contract.json`,
that passes `botalot check`, and its GitHub repo has the factory's labels. **Set up**
beside a realm in the Realms dialog runs `botalot setup` there, which writes a first
contract from the realm's own scripts and creates the labels, and shows what it did. See
the [root README](../README.md).

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
your real kingdom is untouched, and fake dragons (castles and
holdings, every state including dormant) fill the map. Add `-- --shot=out.png` to
capture a screenshot and exit.

Other dev switches: `DRAGON_CLAUDE_BIN` overrides the `claude`
binary, `DRAGON_SCREENSHOT=path.png` captures the window after a delay and quits,
`DRAGON_DEMO=1` alone summons a few fake dragons into your real realms.

## Layout

    src/main       Electron main: sessions (pty), projects, git, hook server, registry watcher
    src/preload    contextBridge API exposed as window.dragon
    src/renderer   React UI; scene/ is the PixiJS kingdom, panel/ is the terminal side panel
    src/shared     Types shared across processes
    hooks/         notify.js, the Claude Code hook forwarder
    scripts/       grouped by concern: demo/ (scripted kingdom + fake claude), skills/ (vendored-skill check)
