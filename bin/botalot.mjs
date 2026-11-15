#!/usr/bin/env node
// The botalot command line. Run it from inside the repo you are working in.

// The app runs this file with its own executable acting as Node. Everything started from here (agents, a repo's
// checks) must not inherit that switch, or an Electron app among them would start as plain Node too.
delete process.env.ELECTRON_RUN_AS_NODE;
import { BRAIN_VERSION, runsDir } from "../cli/lib/paths.mjs";
import { knowledgeFiles, readKnowledge, reviewNames, stackNames, workflowNames } from "../cli/lib/brain.mjs";
import { CONTRACT_FILE, checkContract, readContract } from "../cli/lib/contract.mjs";
import { continueRun, startRun, stopRun, trySkill } from "../cli/lib/driver.mjs";
import { knowledgeIndex, writeKnowledgeIndex } from "../cli/lib/knowledge.mjs";
import { runShell } from "../cli/lib/exec.mjs";
import { topLevel, worktreeTree } from "../cli/lib/git.mjs";
import { OPEN_STATUSES, allStates, isAlive, loadState } from "../cli/lib/runs.mjs";
import { summary } from "../cli/lib/report.mjs";
import { indexLine, setupRepo } from "../cli/lib/setup.mjs";
import { approve, pick, syncLabels } from "../cli/lib/tickets.mjs";
import { board, due } from "../cli/lib/board.mjs";

const HELP = `botalot ${BRAIN_VERSION}

  botalot setup [--no-labels]           Set this repo up: write its contract if it has none, and its labels
  botalot check [workflow]              Check this repo's contract (${CONTRACT_FILE})
  botalot start <workflow> <ticket>     Start a run for a ticket, e.g. botalot start implement 12
                [--owner human|agent]   Override the ticket's owner label
  botalot next [run]                    Carry on this repo's waiting run (after your step, or an answer)
  botalot status [--all] [--json]       Show open runs (or every run)
  botalot stop <run>                    End a run
  botalot verify                        Run the contract's checks on the code as it is now
  botalot labels [--fix] [--prune]      Compare the repo's labels with the factory's ten; create or remove them
  botalot knowledge [--index|--write]   Print the knowledge this repo's contract loads; or its index; or write the index
  botalot skill <name> [--ticket <n>]   Try one step skill by itself, to test it. Nothing is committed or labelled
                [--dry]                 Print the prompt it would get, without starting an agent
  botalot board [--json]                Show the tickets waiting on you: to approve, needing you, yours to build, in review
  botalot pick [ticket]                 Pick a refined ticket to work on: move it to selected (the oldest, with no number)
  botalot approve <ticket>              Approve a routed ticket: move it from selected to ready
  botalot due [--json]                  Show the runs that should be started, by each workflow's trigger
  botalot list                          Show the workflows, reviews and stacks the brain has

Run logs are in ${runsDir()}`;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const words = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--owner" && args[i - 1] !== "--ticket");
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [command, ...rest] = words;

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

/** How a finished or resting run maps to an exit code: 0 fine, 2 it needs the human, 1 it stopped on a problem. */
function exitFor(state) {
  console.log(`\n${summary(state)}`);
  if (state.status === "done" || state.status === "waiting-human") return 0;
  if (state.status === "waiting-you" || state.status === "paused-quota") return 2;
  return 1;
}

function waitingRunHere(id) {
  if (id) return loadState(id);
  const repo = topLevel(process.cwd());
  const open = allStates().filter((s) => s.repo === repo && OPEN_STATUSES.includes(s.status) && !isAlive(s));
  if (open.length === 0) fail("This repo has no run waiting to be carried on.");
  if (open.length > 1) fail(`This repo has ${open.length} waiting runs. Name one:\n${open.map((s) => `  ${s.id} (#${s.ticket}, ${s.status})`).join("\n")}`);
  return open[0];
}

const commands = {
  async setup() {
    const { ok, lines } = setupRepo(topLevel(process.cwd()), { labels: !flags.has("--no-labels") });
    console.log(lines.join("\n"));
    process.exit(ok ? 0 : 1);
  },

  async check() {
    const repo = topLevel(process.cwd());
    const { problems } = checkContract(repo, rest[0]);
    if (problems.length) fail(`The contract does not pass:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    console.log(`The contract passes for ${rest[0] ? `the "${rest[0]}" workflow` : "every workflow it turns on"} (botalot ${BRAIN_VERSION}).`);
  },

  async start() {
    const [workflow, ticket] = rest;
    if (!workflow || !/^\d+$/.test(ticket ?? "")) fail("Usage: botalot start <workflow> <ticket number>");
    const owner = option("--owner");
    if (owner && !["human", "agent"].includes(owner)) fail("--owner is human or agent.");
    const state = await startRun({ cwd: process.cwd(), workflow, ticket: Number(ticket), owner: owner ? `${owner}-owned` : undefined });
    process.exit(exitFor(state));
  },

  async next() {
    const state = await continueRun(waitingRunHere(rest[0]));
    process.exit(exitFor(state));
  },

  async status() {
    const states = allStates().filter((s) => flags.has("--all") || OPEN_STATUSES.includes(s.status));
    if (flags.has("--json")) return console.log(JSON.stringify(states, null, 2));
    if (states.length === 0) return console.log(flags.has("--all") ? "There are no runs." : "No runs are open. `botalot status --all` shows finished ones.");
    for (const s of states) {
      const status = s.status === "running" && !isAlive(s) ? "running (its process has gone; `botalot next` carries it on)" : s.status;
      console.log(`${s.id}  #${s.ticket}  ${s.workflow}  ${s.owner ?? "?"}  ${status}${s.wait ? `  at ${s.wait.step}` : ""}${s.pr ? `  ${s.pr}` : ""}`);
    }
  },

  async stop() {
    if (!rest[0]) fail("Usage: botalot stop <run>");
    const state = stopRun(loadState(rest[0]));
    console.log(summary(state));
  },

  async verify() {
    const repo = topLevel(process.cwd());
    const { contract, problems } = readContract(repo);
    if (!contract) fail(problems.join("\n"));
    if (!contract.commands?.verify?.length) fail(`The contract has no "commands.verify".`);
    let failed = 0;
    for (const command of contract.commands.verify) {
      const r = await runShell(command, { cwd: repo });
      console.log(`${r.code === 0 ? "passed" : `FAILED (exit ${r.code})`}  ${command}  ${r.seconds}s`);
      if (r.code !== 0) {
        failed++;
        console.log(r.output.slice(-3000).trim(), "\n");
      }
    }
    console.log(failed ? `${failed} check(s) failed.` : `Every check passed on ${worktreeTree(repo)}.`);
    process.exit(failed ? 1 : 0);
  },

  async labels() {
    const repo = topLevel(process.cwd());
    const report = syncLabels(repo, { fix: flags.has("--fix"), prune: flags.has("--prune") });
    for (const name of report.set) console.log(`set: ${name}`);
    for (const name of report.pruned) console.log(`removed: ${name}`);
    const missing = report.missing.filter((n) => !report.set.includes(n));
    const retired = report.retired.filter((n) => !report.pruned.includes(n));
    if (missing.length) console.log(`Missing or out of date: ${missing.join(", ")}. Run \`botalot labels --fix\`.`);
    if (retired.length) console.log(`Retired labels still on the repo: ${retired.join(", ")}. \`botalot labels --prune\` deletes them (it also takes them off every ticket).`);
    if (missing.length) process.exit(1);
    if (!retired.length) console.log("The repo's labels match the factory's.");
  },

  async knowledge() {
    const repo = topLevel(process.cwd());
    const { contract, problems } = readContract(repo);
    if (!contract) fail(problems.join("\n"));
    if (flags.has("--write")) return console.log(indexLine(writeKnowledgeIndex(repo, contract)));
    if (flags.has("--index")) return console.log(knowledgeIndex(repo, contract) ?? "botalot is not installed inside this repo, so there is no index to print.");
    const wanted = ["fundamentals", "stacks"];
    console.log(`Files: ${knowledgeFiles(wanted, contract).join(", ")}\n`);
    console.log(readKnowledge(wanted, contract));
  },

  async skill() {
    const ticket = option("--ticket");
    if (!rest[0] || (ticket !== undefined && !/^\d+$/.test(ticket))) fail("Usage: botalot skill <name> [--ticket <number>] [--dry]");
    const result = await trySkill({ cwd: process.cwd(), skill: rest[0], ticket: ticket ? Number(ticket) : undefined, dry: flags.has("--dry") });
    if (result.prompt) return console.log(result.prompt);
    if (result.ok) console.log(JSON.stringify(result.output, null, 2));
    else console.log(result.needsYou ? `The skill stopped and asked (${result.needsYou.kind}):\n\n${result.needsYou.question}` : (result.pause ?? "The skill did not finish."));
    console.log(`\nSession: ${result.session ?? "unknown"}\nPrompt and answer: ${result.files}`);
    process.exit(result.ok ? 0 : 2);
  },

  async board() {
    const b = board(topLevel(process.cwd()));
    if (flags.has("--json")) return console.log(JSON.stringify(b, null, 2));
    const groups = [["To approve", b.toApprove], ["Needs you", b.needsYou], ["Yours to build", b.yoursToBuild], ["In review", b.inReview], ["Refined", b.refined]];
    for (const [title, items] of groups) {
      console.log(`${title} (${items.length})`);
      for (const t of items) console.log(`  #${t.number} ${t.title}${t.owner ? `  [${t.owner}]` : ""}`);
    }
  },

  async pick() {
    if (rest[0] !== undefined && !/^\d+$/.test(rest[0])) fail("Usage: botalot pick [ticket number]");
    console.log(pick(topLevel(process.cwd()), rest[0] === undefined ? undefined : Number(rest[0])));
  },

  async approve() {
    if (!/^\d+$/.test(rest[0] ?? "")) fail("Usage: botalot approve <ticket number>");
    console.log(approve(topLevel(process.cwd()), Number(rest[0])));
  },

  async due() {
    const repo = topLevel(process.cwd());
    const { contract, problems } = checkContract(repo);
    if (problems.length) fail(`The contract does not pass:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    const list = due(repo, contract);
    if (flags.has("--json")) return console.log(JSON.stringify(list, null, 2));
    if (list.length === 0) return console.log("Nothing is due.");
    for (const d of list) console.log(`${d.workflow}  #${d.number} ${d.title}`);
  },

  async list() {
    console.log(`Workflows: ${workflowNames().join(", ")}\nReviews:   ${reviewNames().join(", ")}\nStacks:    ${stackNames().join(", ")}`);
  },
};

if (!command || flags.has("--help") || command === "help") console.log(HELP);
else if (!commands[command]) fail(`"${command}" is not a botalot command.\n\n${HELP}`);
else commands[command]().catch((err) => fail(err.message));
