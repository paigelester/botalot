// The driver: moves a run through its workflow one step at a time. A step is a script (plain code below),
// a skill (a fresh agent), or the human's turn. The driver checks each gate itself, so no step can be skipped.
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadStepSkill, loadWorkflow, reviewNames } from "./brain.mjs";
import { checkContract, limits } from "./contract.mjs";
import { runAgent } from "./agent.mjs";
import { runShell } from "./exec.mjs";
import { matchesGlob } from "./glob.mjs";
import * as g from "./git.mjs";
import * as tickets from "./tickets.mjs";
import { OPEN_STATUSES, allStates, isAlive, logEvent, newRunId, readQuota, runDir, saveState, writeQuota } from "./runs.mjs";
import { findingLine, fixComment, planComment, prBody, prWorkBrief, stepPrompt, threadReply } from "./report.mjs";

const AGENT = "agent-owned";
const HUMAN = "human-owned";

/** Whether nobody is watching this run: everything but a run on a ticket the human is building themselves. */
const unattended = (state) => state.owner !== HUMAN;

/** How many fix rounds a pull request gets before the next one asks first. */
const MAX_FIX_ROUNDS = 3;

/** Start a run. Refuses when the contract is unmet or a limit says no. Returns the run's state when it rests. */
export async function startRun({ cwd, workflow, ticket, owner, say = console.log }) {
  const repo = g.topLevel(cwd);
  const { contract, problems } = checkContract(repo, workflow);
  if (problems.length) throw new Error(`This repo can't run the "${workflow}" workflow yet:\n${problems.map((p) => `- ${p}`).join("\n")}`);

  const open = allStates().filter((s) => OPEN_STATUSES.includes(s.status));
  // A holding (worktree) of the repo is still that repo: one run per ticket across all of them.
  const mainRepo = g.mainCheckout(repo);
  const same = open.find((s) => (s.mainRepo ?? s.repo) === mainRepo && s.ticket === ticket);
  if (same) throw new Error(`Ticket #${ticket} already has a run (${same.id}, ${same.status}). Use \`botalot next\` to carry it on or \`botalot stop\` to end it.`);
  const running = open.filter(isAlive).length;
  const max = limits(contract).maxRuns;
  if (running >= max) throw new Error(`${running} runs are going and the limit is ${max}. Try again when one finishes.`);

  const state = {
    id: newRunId(repo, ticket),
    workflow,
    kind: loadWorkflow(workflow).kind ?? "work",
    repo,
    mainRepo,
    repoName: basename(mainRepo),
    ticket,
    owner: owner ?? null,
    status: "running",
    pid: process.pid,
    stepIndex: 0,
    loops: {},
    humanDone: {},
    rework: null,
    wait: null,
    activeSeconds: 0,
    startedAt: new Date().toISOString(),
  };
  saveState(state);
  logEvent(state, "run-start", { repoPath: repo, mainRepo });
  return advance(state, { contract, say });
}

/** Carry on a run that is waiting: for the human's step, for an answer, or for the usage window. */
export async function continueRun(state, { say = console.log } = {}) {
  if (state.status === "running" && isAlive(state)) throw new Error(`Run ${state.id} is already going (process ${state.pid}).`);
  if (!OPEN_STATUSES.includes(state.status)) throw new Error(`Run ${state.id} is ${state.status}; there is nothing to carry on.`);
  const { contract, problems } = checkContract(state.repo, state.workflow);
  if (problems.length) throw new Error(`The repo's contract no longer passes:\n${problems.map((p) => `- ${p}`).join("\n")}`);

  if (state.status === "waiting-human") {
    // The human did the step themselves, so it counts as done and the gates after it run on their work.
    state.humanDone[state.wait.step] = true;
  } else if (state.status === "waiting-you" && unattended(state)) {
    tickets.relabel(state.repo, state.ticket, ["factory:needs-you"], []);
  }
  logEvent(state, "run-continue", { from: state.status });
  state.status = "running";
  state.pid = process.pid;
  state.wait = null;
  saveState(state);
  return advance(state, { contract, say });
}

export function stopRun(state, reason = "Stopped by hand.") {
  state.status = "stopped";
  state.stopped = reason;
  state.wait = null;
  saveState(state);
  logEvent(state, "run-end", { status: "stopped", reason });
  return state;
}

async function advance(state, ctx) {
  const workflow = loadWorkflow(state.workflow);
  const steps = workflow.steps;
  const indexOf = (id) => steps.findIndex((s) => s.id === id);
  const budget = limits(ctx.contract).minutesPerRun * 60;

  while (state.status === "running") {
    const step = steps[state.stepIndex];
    if (!step) {
      state.status = "done";
      saveState(state);
      logEvent(state, "run-end", { status: "done", seconds: state.activeSeconds, pr: state.pr ?? null });
      break;
    }
    if (step.only && state.owner && step.only !== state.owner) {
      logEvent(state, "step-skip", { step: step.id, why: `only for ${step.only}` });
      state.stepIndex++;
      continue;
    }
    if (step.when === "changed" && state.changed === false) {
      logEvent(state, "step-skip", { step: step.id, why: "nothing changed this round" });
      state.stepIndex++;
      continue;
    }
    if (step.human && step.human === state.owner) {
      if (!state.humanDone[step.id]) {
        const detail = state.rework ? `It did not pass "${state.rework.from}":\n\n${state.rework.detail}` : null;
        rest(state, "waiting-human", { step: step.id, reason: `Your turn: ${step.id} for #${state.ticket} on branch ${state.branch}.`, detail });
        break;
      }
      state.humanDone[step.id] = false;
      state.rework = null;
      state.stepIndex++;
      continue;
    }
    if (unattended(state) && state.activeSeconds >= budget) {
      await needsYou(state, step, { kind: "blocked", question: `The run reached its ${limits(ctx.contract).minutesPerRun} minute limit at the "${step.id}" step. Carry it on with \`botalot next\`, or take the ticket over.` });
      break;
    }

    ctx.say(`[${state.id}] ${step.id}...`);
    logEvent(state, "step-start", { step: step.id });
    const started = Date.now();
    let result;
    try {
      result = step.skill ? await skillStep(state, step, ctx) : await SCRIPTS[step.script](state, step, ctx);
    } catch (err) {
      // Something outside the step's control (GitHub down, git refusing). Rest here so `botalot next` can retry it.
      result = { needsYou: { kind: "blocked", question: `The "${step.id}" step could not run: ${err.message}` } };
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    state.activeSeconds += seconds;
    const outcome = result.ok || result.finish ? "passed" : result.pause ? "paused" : result.needsYou ? "needs-you" : result.stop ? "stopped" : "failed";
    logEvent(state, "step-end", { step: step.id, outcome, seconds, ...(result.log ?? {}) });

    if (result.ok) {
      state.rework = null;
      state.stepIndex++;
    } else if (result.finish) {
      // The step found there is nothing left for this run to do.
      state.note = result.finish;
      state.stepIndex = steps.length;
    } else if (result.pause) {
      rest(state, "paused-quota", { step: step.id, reason: result.pause });
    } else if (result.needsYou) {
      await needsYou(state, step, result.needsYou);
    } else if (result.stop) {
      state.status = "stopped";
      state.stopped = result.stop;
      logEvent(state, "run-end", { status: "stopped", reason: result.stop });
    } else {
      // A gate failed. Go back to the step that can fix it, unless this gate has already failed too often.
      const target = result.goto ?? step.onFail;
      state.loops[step.id] = (state.loops[step.id] ?? 0) + 1;
      const max = step.maxLoops ?? 1;
      if (!target || state.loops[step.id] > max) {
        await needsYou(state, step, { kind: "decision", question: `The "${step.id}" step has failed ${state.loops[step.id]} time(s) and the limit is ${max}.\n\n${result.detail}` });
      } else {
        logEvent(state, "loop", { step: step.id, to: target, round: state.loops[step.id], of: max });
        state.rework = { from: step.id, detail: result.detail };
        state.stepIndex = indexOf(target);
      }
    }
    saveState(state);
  }
  return state;
}

function rest(state, status, wait) {
  state.status = status;
  state.wait = wait;
  saveState(state);
  logEvent(state, "wait", { status, step: wait.step, reason: wait.reason });
}

/** Stop and ask. On an agent-owned ticket nobody is watching, so flag the ticket and say why on GitHub. */
async function needsYou(state, step, { kind, question }) {
  const title = kind === "blocked" ? "Blocked" : "Decision needed";
  if (unattended(state)) {
    try {
      const ticket = tickets.readTicket(state.repo, state.ticket);
      const login = tickets.humanFor(state.repo, ticket);
      tickets.relabel(state.repo, state.ticket, [], ["factory:needs-you"]);
      tickets.comment(state.repo, state.ticket, `${login ? `@${login} ` : ""}**${title}** (botalot run \`${state.id}\`, step \`${step.id}\`)\n\n${question}`);
    } catch (err) {
      logEvent(state, "notify-failed", { error: err.message });
    }
  }
  rest(state, "waiting-you", { step: step.id, reason: `${title} at the "${step.id}" step.`, detail: question });
}

// ---------------------------------------------------------------------------------------------- agent steps

/** Stands in for the ticket when a skill is tried out with none. */
const NO_TICKET = { number: 0, title: "(no ticket: this is a test of the skill)", body: "", comments: [] };

/** What a reviewer is told to look at. */
function reviewBrief(review, base, files) {
  return `# What to review\n\nThe \`${review}\` review of these changed files (compare with \`git diff ${base}\`; untracked files are new):\n\n${files.map((f) => `- ${f}`).join("\n")}`;
}

/**
 * Try one step skill by itself, outside any workflow: for testing a skill's wording, not for doing work.
 * It gets the same prompt, knowledge and permissions as in a run, against the repo as it is now, but nothing
 * around it happens: no ticket is claimed or labelled, nothing is committed, no gate runs. With `dry`, no
 * agent starts and the prompt it would get is returned instead.
 */
export async function trySkill({ cwd, skill: name, ticket: number, dry = false }) {
  const repo = g.topLevel(cwd);
  const { contract, problems } = checkContract(repo);
  if (problems.length) throw new Error(`This repo's contract does not pass:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  const skill = loadStepSkill(name);
  const base = g.git(repo, "merge-base", "HEAD", g.defaultRef(repo, contract));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const state = { id: `skill-${name}-${stamp}`, workflow: "skill", repo, repoName: basename(g.mainCheckout(repo)), ticket: number ?? 0, owner: null, branch: g.currentBranch(repo), base, activeSeconds: 0, rework: null };
  const step = { id: name };
  const extra = name.startsWith("review-") ? reviewBrief(name.slice(7), base, g.changedFiles(repo, base)) : "";
  if (dry) {
    const ticket = number ? tickets.readTicket(repo, number) : NO_TICKET;
    return { id: state.id, prompt: stepPrompt({ state, step, skill, contract, ticket, extra }) };
  }
  const result = await agentStep(state, step, { contract }, name, extra);
  return { id: state.id, files: runDir(state.id), ...result };
}

/** Run a step skill as a fresh agent. Returns the step result plus `output`, the agent's structured answer. */
async function agentStep(state, step, ctx, skillName, extra = "") {
  const { contract } = ctx;
  if (unattended(state)) {
    const quota = readQuota();
    const limit = limits(contract).pauseAtQuotaPercent;
    if (quota?.fiveHour && quota.fiveHour.usedPercent >= limit) {
      return { pause: `${quota.fiveHour.usedPercent}% of the 5-hour usage window is used and unattended runs pause at ${limit}%.` };
    }
  }
  const skill = loadStepSkill(skillName);
  const ticket = state.ticket ? tickets.readTicket(state.repo, state.ticket) : NO_TICKET;
  const dir = runDir(state.id);
  const attempt = `${step.id}-${skillName}-${Date.now()}`;
  const prompt = stepPrompt({ state, step, skill, contract, ticket, extra });
  writeFileSync(join(dir, `${attempt}.prompt.md`), prompt);

  const remaining = unattended(state) ? Math.max(60, limits(contract).minutesPerRun * 60 - state.activeSeconds) : null;
  const res = await runAgent({
    cwd: state.repo,
    prompt,
    schema: skill.step.output,
    permissions: {
      edits: Boolean(skill.step.edits),
      tools: skill.step.tools ?? [],
      bash: [...(skill.step.bash ?? []), ...(skill.step.verifyCommands ? (contract.commands?.verify ?? []) : []), ...(contract.allow ?? [])],
    },
    settingsPath: join(dir, `${attempt}.settings.json`),
    name: `botalot ${state.repoName}#${state.ticket} ${step.id}`,
    runId: state.id,
    timeoutMs: remaining ? remaining * 1000 : undefined,
    model: skill.step.model,
    mcp: contract.mcp === true,
    onActivity: (text) => logEvent(state, "activity", { step: step.id, skill: skillName, text }),
  });
  writeFileSync(join(dir, `${attempt}.output.json`), JSON.stringify(res, null, 2));
  if (res.quota) writeQuota(res.quota);
  logEvent(state, "agent", { step: step.id, skill: skillName, session: res.session, seconds: res.seconds, cost: res.cost, tokens: res.tokens, turns: res.turns, model: res.model, tools: res.tools, skills: res.skills, ok: res.ok });

  if (!res.ok) return { needsYou: { kind: "blocked", question: `${res.error}\n\nThe session is \`${res.session ?? "unknown"}\`; reopen it with \`claude --resume ${res.session ?? "<id>"}\`.` } };
  if (res.output.status === "needs-human") return { needsYou: { kind: res.output.kind === "blocked" ? "blocked" : "decision", question: res.output.question ?? "The agent stopped without saying what it needs." } };
  return { ok: true, output: res.output, session: res.session };
}

async function skillStep(state, step, ctx) {
  const result = await agentStep(state, step, ctx, step.skill, state.brief ?? "");
  if (!result.ok) return result;
  return step.then ? SCRIPTS[step.then](state, step, ctx, result.output) : { ok: true };
}

// --------------------------------------------------------------------------------------------- script steps

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/** Run the contract's setup commands: a fresh worktree has no installed dependencies, so the checks would fail before they start. */
async function runSetup(state, step, contract) {
  for (const command of contract.commands?.setup ?? []) {
    const r = await runShell(command, { cwd: state.repo, timeoutMs: 30 * 60 * 1000 });
    logEvent(state, "setup", { step: step.id, command, exit: r.code, seconds: r.seconds });
    if (r.code !== 0) return { stop: `The setup command "${command}" failed (exit ${r.code}):\n\n${r.output.slice(-2000).trim()}` };
  }
  return null;
}

const SCRIPTS = {
  /** Take the ticket: check it is ready and owned, move it to in-progress, and get onto its branch. */
  async claim(state, step, { contract }) {
    const { repo } = state;
    const ticket = tickets.readTicket(repo, state.ticket);
    if (ticket.state !== "OPEN") return { stop: `Ticket #${ticket.number} is closed.` };
    state.owner = state.owner ?? ticket.owner;
    if (!state.owner) return { stop: `Ticket #${ticket.number} has no owner label (factory:agent-owned or factory:human-owned). Route it first.` };
    const ready = ticket.labels.includes("factory:ready");
    if (!ready && !ticket.labels.includes("factory:in-progress")) return { stop: `Ticket #${ticket.number} is not at factory:ready, so it is not approved to build.` };
    if (state.owner === AGENT && !g.isClean(repo)) return { stop: `The working tree has uncommitted changes. An unattended run needs a clean tree to start from.` };

    const base = g.defaultBranch(repo, contract);
    if (g.currentBranch(repo) === base) {
      g.tryGit(repo, "fetch", "origin", base);
      const branch = `${ticket.number}-${slug(ticket.title)}`;
      if (g.tryGit(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).code === 0) g.git(repo, "checkout", branch);
      else g.git(repo, "checkout", "-b", branch, g.defaultRef(repo, contract));
    }
    state.branch = g.currentBranch(repo);
    state.defaultBranch = base;
    state.base = g.git(repo, "merge-base", "HEAD", g.defaultRef(repo, contract));

    const failed = await runSetup(state, step, contract);
    if (failed) return failed;

    if (ready) tickets.relabel(repo, ticket.number, ["factory:ready"], ["factory:in-progress"]);
    try {
      tickets.assignToMe(repo, ticket.number);
    } catch {
      // Assigning is a courtesy; a repo that doesn't allow it shouldn't stop the run.
    }
    writeFileSync(join(runDir(state.id), "ticket.json"), JSON.stringify(ticket, null, 2));
    return { ok: true, log: { owner: state.owner, branch: state.branch, base: state.base } };
  },

  /** Take a ticket for planning: it must be selected and not yet routed. Nothing is claimed, branched or changed. */
  async "select-ticket"(state) {
    const { repo } = state;
    const ticket = tickets.readTicket(repo, state.ticket);
    if (ticket.state !== "OPEN") return { stop: `Ticket #${ticket.number} is closed.` };
    if (!ticket.labels.includes("factory:selected")) return { stop: `Ticket #${ticket.number} is not at factory:selected, so it has not been picked to work on.` };
    if (ticket.owner) return { stop: `Ticket #${ticket.number} already has an owner (${ticket.owner}), so it has been routed. \`botalot approve ${ticket.number}\` makes it ready.` };
    state.branch = g.currentBranch(repo);
    state.base = g.head(repo);
    writeFileSync(join(runDir(state.id), "ticket.json"), JSON.stringify(ticket, null, 2));
    return { ok: true };
  },

  /**
   * After the route agent: pick the owner by rule, never by the agent's say-so, then post the plan and the
   * owner label. The ticket stays selected: making it ready is the human's move (`botalot approve`).
   */
  async "post-plan"(state, step, ctx, output) {
    if (!output.risk || !output.solvability) return { needsYou: { kind: "decision", question: "The route step finished without a risk and a solvability rating." } };
    const owner = ["low", "medium"].includes(output.risk) && output.solvability === "yes" ? AGENT : HUMAN;
    tickets.comment(state.repo, state.ticket, planComment(output, owner, state.id));
    tickets.relabel(state.repo, state.ticket, [], [`factory:${owner}`]);
    state.plan = { owner, risk: output.risk, solvability: output.solvability };
    return { ok: true, log: state.plan };
  },

  /**
   * Take a ticket's open pull request for a fix round: get onto its branch as it was pushed, and list what
   * needs an answer (failing checks, review threads, comments). With nothing on the list, the run is done.
   */
  async "collect-pr"(state, step, { contract }) {
    const { repo } = state;
    const ticket = tickets.readTicket(repo, state.ticket);
    if (ticket.state !== "OPEN") return { stop: `Ticket #${ticket.number} is closed.` };
    state.owner = state.owner ?? ticket.owner;
    const pr = tickets.prForTicket(repo, ticket.number);
    if (!pr) return { stop: `Ticket #${ticket.number} has no open pull request.` };
    if (pr.checks.pending) return { stop: `${pr.url} still has ${pr.checks.pending} check(s) running. Try again when they finish.` };
    if (!g.isClean(repo)) return { stop: `The working tree has uncommitted changes. A fix round needs a clean tree to start from.` };

    g.tryGit(repo, "fetch", "origin", pr.branch);
    const pushed = `origin/${pr.branch}`;
    if (g.currentBranch(repo) !== pr.branch) {
      if (g.tryGit(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${pr.branch}`).code === 0) g.git(repo, "checkout", pr.branch);
      else g.git(repo, "checkout", "-b", pr.branch, pushed);
    }
    if (g.tryGit(repo, "merge", "--ff-only", pushed).code !== 0) return { stop: `The local branch ${pr.branch} and the pushed pull request have gone different ways. Make them match, then start again.` };
    state.branch = pr.branch;
    state.defaultBranch = g.defaultBranch(repo, contract);
    state.base = g.git(repo, "merge-base", "HEAD", g.defaultRef(repo, contract));
    state.roundBase = g.head(repo);
    state.pr = pr.url;
    state.prNumber = pr.number;

    const feedback = tickets.prFeedback(repo, pr.number);
    const work = [
      ...pr.checks.failing.map((c, i) => ({ id: `check-${i + 1}`, type: "check", name: c.name, url: c.url })),
      ...feedback.threads.map((t, i) => ({ id: `thread-${i + 1}`, type: "thread", ...t })),
      ...feedback.comments.map((c, i) => ({ id: `comment-${i + 1}`, type: "comment", ...c })),
    ];
    const log = { pr: pr.url, checks: pr.checks.failing.length, threads: feedback.threads.length, comments: feedback.comments.length };
    if (work.length === 0) return { finish: `${pr.url} has no failing check and nothing unanswered.`, log };

    const rounds = allStates().filter((s) => s.workflow === state.workflow && s.prNumber === pr.number && (s.mainRepo ?? s.repo) === state.mainRepo && s.status === "done" && s.fixed).length;
    if (rounds >= MAX_FIX_ROUNDS && !state.roundsAsked) {
      state.roundsAsked = true;
      return { needsYou: { kind: "decision", question: `${pr.url} has had ${rounds} fix rounds and still has ${work.length} item(s) to answer. Carry on with \`botalot next\` for another round, or take the pull request over.` } };
    }

    const failed = await runSetup(state, step, contract);
    if (failed) return failed;
    state.prWork = work;
    state.brief = prWorkBrief(pr, work);
    writeFileSync(join(runDir(state.id), "pr-work.json"), JSON.stringify(work, null, 2));
    return { ok: true, log };
  },

  /**
   * After the fix agent: every item must have an answer, and an item called fixed must come with a change.
   * The work is saved as a commit; a round that changed nothing skips the gates that judge a change.
   */
  async "save-fix"(state, step, ctx, output) {
    const answers = new Map((output.items ?? []).map((i) => [i.id, i]));
    const missing = state.prWork.filter((w) => !answers.get(w.id)?.verdict || !answers.get(w.id)?.reply);
    if (missing.length) return { ok: false, detail: `Every item needs a verdict and a reply. Missing: ${missing.map((w) => w.id).join(", ")}.` };
    g.saveWork(state.repo, `chore: botalot work in progress (${state.id})`);
    state.changed = g.headTree(state.repo) !== g.git(state.repo, "rev-parse", `${state.roundBase}^{tree}`);
    const fixed = state.prWork.filter((w) => answers.get(w.id).verdict === "fixed");
    if (fixed.length && !state.changed) return { ok: false, detail: `You called ${fixed.map((w) => w.id).join(", ")} fixed, but no file changed. Make the fix, or give a different verdict.` };
    state.fix = { summary: output.summary, commitMessage: output.commitMessage, items: state.prWork.map((w) => ({ id: w.id, verdict: answers.get(w.id).verdict, reply: answers.get(w.id).reply })) };
    return { ok: true, log: { changed: state.changed } };
  },

  /**
   * Answer what the round took on: a reply on every review thread, and one comment on the pull request for
   * the checks, the comments and the verify result. Each answer is marked, so the same item is not due again.
   */
  async "answer-pr"(state) {
    const commit = state.changed ? g.head(state.repo).slice(0, 7) : null;
    const answered = (state.answered ??= {});
    for (const item of state.fix.items) {
      const work = state.prWork.find((w) => w.id === item.id);
      if (work.type !== "thread" || answered[item.id]) continue;
      tickets.replyToThread(state.repo, state.prNumber, work.replyTo, threadReply(item, commit, state.ticket));
      answered[item.id] = true;
      saveState(state);
    }
    if (!answered.summary) {
      tickets.commentOnPr(state.repo, state.prNumber, fixComment(state, commit));
      answered.summary = true;
    }
    state.fixed = true;
    return { ok: true, log: { answered: state.fix.items.length, commit } };
  },

  /** After the build agent: keep its answer for the PR, and save its work as a commit. */
  async "save-work"(state, step, ctx, output) {
    state.build = { summary: output.summary, commitMessage: output.commitMessage, criteria: output.criteria ?? [] };
    g.saveWork(state.repo, `chore: botalot work in progress (${state.id})`);
    if (g.changedFiles(state.repo, state.base).length === 0) {
      return { needsYou: { kind: "decision", question: `The build step finished but changed no files. Its summary: ${output.summary}` } };
    }
    return { ok: true };
  },

  /** Run every check in the contract and stamp a pass with the exact files it passed on. */
  async verify(state, step, { contract }) {
    const dir = runDir(state.id);
    const round = (state.verifyRounds = (state.verifyRounds ?? 0) + 1);
    const results = [];
    const failures = [];
    for (const [i, command] of contract.commands.verify.entries()) {
      logEvent(state, "activity", { step: step.id, text: `$ ${command}` });
      const r = await runShell(command, { cwd: state.repo, timeoutMs: 30 * 60 * 1000 });
      const file = join(dir, `verify-${round}-${i + 1}.log`);
      writeFileSync(file, `$ ${command}\n${r.output}\n(exit ${r.code})\n`);
      results.push({ command, exit: r.code, seconds: r.seconds });
      logEvent(state, "check", { step: step.id, command, exit: r.code, seconds: r.seconds, output: file });
      if (r.code !== 0) failures.push(`$ ${command} (exit ${r.code}${r.timedOut ? ", timed out" : ""})\n${r.output.slice(-3000).trim()}`);
    }
    const tree = g.worktreeTree(state.repo);
    if (failures.length) {
      state.verified = null;
      return { ok: false, detail: failures.join("\n\n"), log: { tree, results } };
    }
    state.verified = { tree, at: new Date().toISOString(), results };
    return { ok: true, log: { tree, results } };
  },

  /** Pick the reviews this change needs from the contract's rules, and run each as its own fresh agent. */
  async reviews(state, step, ctx) {
    const files = g.changedFiles(state.repo, state.base);
    if (files.length === 0) return { ok: false, detail: "Nothing has changed against the default branch, so there is nothing to review." };
    const picked = pickReviews(ctx.contract, files);
    const before = g.worktreeTree(state.repo);
    const findings = [];
    let criteria = [];
    for (const review of picked) {
      const extra = reviewBrief(review, state.base, files);
      const result = await agentStep(state, step, ctx, `review-${review}`, extra);
      if (!result.ok) return result;
      for (const f of result.output.findings ?? []) findings.push({ ...f, review });
      if (result.output.criteria?.length) criteria = result.output.criteria;
    }
    const tree = g.worktreeTree(state.repo);
    if (tree !== before) return { stop: "A reviewer changed files. Reviewers report; they never fix. The run was stopped so nothing unreviewed goes further." };

    for (const c of criteria) if (c.verdict !== "met") findings.push({ severity: "must", file: c.metBy || "(nowhere)", problem: `Acceptance criterion not met: ${c.criterion}`, fix: "Make the change meet it.", review: "criteria" });
    const must = findings.filter((f) => f.severity === "must");
    const should = findings.filter((f) => f.severity !== "must");
    state.reviewed = { tree, reviews: picked, must: must.length, should: should.length, findings, criteria };
    writeFileSync(join(runDir(state.id), `review-${Date.now()}.json`), JSON.stringify(state.reviewed, null, 2));
    const log = { tree, reviews: picked, must: must.length, should: should.length };
    if (must.length === 0) return { ok: true, log };
    const detail = [`Fix every \`must\` finding:`, ...must.map(findingLine), ...(should.length ? [``, `Worth fixing while you are there (\`should\`):`, ...should.map(findingLine)] : [])].join("\n");
    return { ok: false, detail, log };
  },

  /** Turn the run's (or the fix round's) work-in-progress commits into one commit, written in the repo's style, with hooks running. */
  async squash(state) {
    const { repo } = state;
    g.saveWork(repo, `chore: botalot work in progress (${state.id})`);
    const tree = g.headTree(repo);
    if (state.verified?.tree !== tree) return { ok: false, goto: "verify", detail: "The code changed after it was verified." };
    if (state.reviewed?.tree !== tree) return { ok: false, goto: "review", detail: "The code changed after it was reviewed." };

    const before = g.head(repo);
    const messageFile = join(runDir(state.id), "commit-message.txt");
    const work = state.fix ?? state.build;
    const subject = (work?.commitMessage ?? "").split("\n")[0].trim() || `chore: work for #${state.ticket}`;
    // A fix round adds one commit on top of the pull request; the ticket is closed by the first commit, not this one.
    writeFileSync(messageFile, `${subject}\n\n${work?.summary ?? ""}\n\n${state.roundBase ? "Refs" : "Closes"} #${state.ticket}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`);
    g.git(repo, "reset", "--soft", state.roundBase ?? state.base);
    const commit = g.tryGit(repo, "commit", "-F", messageFile);
    if (commit.code !== 0) {
      g.git(repo, "reset", "--soft", before);
      return { ok: false, detail: `The repo's commit hooks refused the commit "${subject}":\n\n${(commit.stderr + commit.stdout).slice(-3000).trim()}` };
    }
    if (g.headTree(repo) !== tree || !g.isClean(repo)) {
      state.verified = null;
      return { ok: false, goto: "verify", detail: "The repo's commit hooks changed files, so the result has to be verified again." };
    }
    return { ok: true, log: { commit: g.head(repo), subject } };
  },

  /** Push and open the PR. Refused unless a verify pass is on record for exactly the files being pushed. */
  async "open-pr"(state) {
    const { repo } = state;
    if (!g.isClean(repo) || state.verified?.tree !== g.headTree(repo)) return { ok: false, goto: "verify", detail: "There is no verify pass for the code as it is now." };
    const push = g.tryGit(repo, "push", "--force-with-lease", "-u", "origin", state.branch);
    if (push.code !== 0) return { needsYou: { kind: "blocked", question: `Pushing ${state.branch} was refused:\n\n${push.stderr.trim()}` } };
    state.pr = tickets.prForBranch(repo, state.branch);
    if (!state.pr) {
      const bodyFile = join(runDir(state.id), "pr-body.md");
      writeFileSync(bodyFile, prBody(state));
      const title = g.git(repo, "log", "-1", "--format=%s");
      state.pr = tickets.openPr(repo, { title, bodyFile, base: state.defaultBranch, head: state.branch });
    }
    return { ok: true, log: { pr: state.pr } };
  },

  /** Hand the work on: an agent's PR goes to review; a human's branch is theirs to open a PR from. */
  async handoff(state) {
    if (state.owner === AGENT && state.pr) {
      tickets.relabel(state.repo, state.ticket, ["factory:in-progress"], ["factory:in-review"]);
      tickets.comment(state.repo, state.ticket, `PR opened: ${state.pr} (botalot run \`${state.id}\`)`);
    }
    return { ok: true };
  },
};

/** The script steps a workflow file may name. */
export const SCRIPT_NAMES = Object.keys(SCRIPTS);

/**
 * The reviews a set of changed files needs: every review of every contract rule a file matches, in the
 * order the brain lists them. A file no rule covers still gets the `code` review, so nothing goes unreviewed.
 */
export function pickReviews(contract, files) {
  const wanted = new Set();
  for (const file of files) {
    const rules = (contract.reviews ?? []).filter((rule) => rule.paths.some((p) => matchesGlob(file, p)));
    if (rules.length === 0) wanted.add("code");
    for (const rule of rules) for (const r of rule.run) wanted.add(r);
  }
  return reviewNames().filter((r) => wanted.has(r));
}

export { AGENT, HUMAN };
