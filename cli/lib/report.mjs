// The words a run leaves behind: the prompt each agent gets, the PR body, and the summary printed at the end.
import { readKnowledge } from "./brain.mjs";

/** The prompt for one agent step: the step skill, the knowledge it loads, then this run's inputs. */
export function stepPrompt({ state, step, skill, contract, ticket, extra = "" }) {
  const parts = [
    `You are one step of a botalot run. Do this step and nothing after it: a driver program runs the other steps and does everything outside this one, such as committing, opening the PR and labelling the ticket. Do not commit, push, change branches, or edit the ticket. Give your answer in the required structured shape when you are done.`,
    `# Step: ${step.id}\n\n${skill.instructions}`,
  ];
  const knowledge = readKnowledge(skill.step.knowledge ?? [], contract);
  if (knowledge) parts.push(`# Knowledge\n\nHow this work is done and judged. A later file overrules an earlier one, and the repo's own rules (its CLAUDE.md or AGENTS.md) overrule them all.\n\n${knowledge}`);

  const inputs = [
    `# Inputs`,
    `- Run: ${state.id}`,
    `- Branch: ${state.branch}`,
    `- Compare against: ${state.base} (the commit this work started from)`,
    ...(state.workflow === "route" ? [] : [`- Checks the driver runs after this step: ${(contract.commands?.verify ?? []).map((c) => `\`${c}\``).join(", ")}`]),
    ``,
    `## Ticket #${ticket.number}: ${ticket.title}`,
    ``,
    ticket.body.trim() || "(the ticket has no body)",
  ];
  if (ticket.comments.length) {
    inputs.push(``, `### Comments`);
    for (const c of ticket.comments) inputs.push(``, `**${c.author}:**`, c.body.trim());
  }
  parts.push(inputs.join("\n"));
  if (extra) parts.push(extra);
  if (state.rework) parts.push(`# Rework\n\nAn earlier attempt did not pass the "${state.rework.from}" step. Fix exactly what is below, and keep every acceptance criterion met.\n\n${state.rework.detail}`);
  return parts.join("\n\n");
}

const checkLine = (r) => `- \`${r.command}\`: ${r.exit === 0 ? "passed" : `failed (exit ${r.exit})`} in ${r.seconds}s`;

function criteriaTable(criteria) {
  if (!criteria?.length) return "_No criteria were reported._";
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return ["| # | Criterion | Met by |", "|---|---|---|", ...criteria.map((c, i) => `| ${i + 1} | ${cell(c.criterion)} | ${cell(c.metBy)} |`)].join("\n");
}

export function findingLine(f) {
  return `- ${f.severity} · ${f.file}${f.line ? `:${f.line}` : ""} · ${f.problem} · ${f.fix}`;
}

const bullets = (items, none) => (items?.length ? items.map((i) => `- ${i}`) : [`- ${none}`]);

/** The plan a route run posts on its ticket, for the human who approves it. The board reads it back by its heading. */
export function planComment(output, owner, runId) {
  return [
    `## Routing plan`,
    ``,
    `**Owner:** ${owner} (rule: risk ${output.risk}, solvability ${output.solvability})`,
    ``,
    `### Approach`,
    ...bullets(output.approach, "not given"),
    ``,
    `### Risk: ${output.risk}`,
    ...bullets(output.riskReasons, "no reason given"),
    ``,
    `### Solvability: ${output.solvability}`,
    ...bullets(output.solvabilityReasons, "nothing only a human has"),
    ``,
    `### Areas touched`,
    ...bullets(output.areas, "not given"),
    ``,
    `Approve with \`botalot approve\`, or by moving the ticket to \`factory:ready\`. Botalot run \`${runId}\`.`,
  ].join("\n");
}

const quote = (text) => text.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");

/** What the fix agent is told to answer: every failing check, review thread and comment, each with an id. */
export function prWorkBrief(pr, work) {
  const lines = [`# What to answer`, ``, `Pull request ${pr.url} (#${pr.number}). Answer every item below, by its id.`];
  for (const w of work) {
    if (w.type === "check") lines.push(``, `## ${w.id}: the check "${w.name}" failed`, ``, w.url ? `Its page: ${w.url}` : `Find its log with \`gh pr checks ${pr.number}\`.`);
    else if (w.type === "thread") {
      lines.push(``, `## ${w.id}: a review thread on ${w.path || "the change"}${w.line ? `:${w.line}` : ""}`);
      for (const c of w.comments) lines.push(``, `**${c.author}:**`, quote(c.body));
    } else lines.push(``, `## ${w.id}: a comment on the pull request`, ``, `**${w.author}:**`, quote(w.body));
  }
  return lines.join("\n");
}

const VERDICT = { fixed: "Fixed", "push-back": "Not changed", "out-of-scope": "Out of scope", "nothing-to-do": "Nothing to do" };

/** The reply botalot leaves on a review thread. */
export function threadReply(item, commit, ticket) {
  if (item.verdict === "fixed") return `Fixed in ${commit}. ${item.reply}`;
  if (item.verdict === "out-of-scope") return `Out of scope for #${ticket}: ${item.reply}`;
  return item.reply;
}

/** The comment a fix round leaves on its pull request: what it did about each item, and the checks it ran. */
export function fixComment(state, commit) {
  const lines = [`## Fix round`, ``, commit ? `${state.fix.summary ?? "Fixes pushed."} Pushed as ${commit}.` : `No code changed this round.`, ``];
  for (const item of state.fix.items) {
    const work = state.prWork.find((w) => w.id === item.id);
    const what = work.type === "check" ? `Check \`${work.name}\`` : work.type === "thread" ? `Thread on ${work.path || "the change"}${work.line ? `:${work.line}` : ""}` : `Comment by ${work.author}`;
    lines.push(`- ${what}: **${VERDICT[item.verdict] ?? item.verdict}.** ${item.reply}`);
  }
  if (commit && state.verified) lines.push(``, `### Verification`, ``, ...state.verified.results.map(checkLine));
  lines.push(``, `Botalot run \`${state.id}\`.`);
  return lines.join("\n");
}

/** The body of the PR an agent-owned run opens. */
export function prBody(state) {
  const should = (state.reviewed?.findings ?? []).filter((f) => f.severity === "should");
  return [
    `Closes #${state.ticket}`,
    ``,
    `## What changed`,
    ``,
    state.build?.summary ?? "",
    ``,
    `## Acceptance criteria`,
    ``,
    criteriaTable(state.build?.criteria),
    ``,
    `## Verification`,
    ``,
    ...(state.verified?.results ?? []).map(checkLine),
    ``,
    `## Review`,
    ``,
    `Reviews run: ${(state.reviewed?.reviews ?? []).join(", ") || "none"}. Result: 0 must, ${should.length} should.`,
    ...(should.length ? [``, ...should.map(findingLine)] : []),
    ``,
    `Factory run \`${state.id}\`.`,
    ``,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n");
}

/** What the driver prints when a run stops, whatever the reason. */
export function summary(state) {
  const lines = [`Run ${state.id}: ${state.status}`];
  const add = (...more) => lines.push(...more);
  if (state.status === "done") {
    if (state.plan) add(`Routed #${state.ticket}: ${state.plan.owner} (risk ${state.plan.risk}, solvability ${state.plan.solvability}).`, `Approve it with \`botalot approve ${state.ticket}\`.`);
    if (state.note) add(state.note);
    if (state.fix) add(`Answered ${state.fix.items.length} item(s) on the pull request${state.changed ? ", with a new commit" : ", with no code change"}.`);
    if (state.pr) add(`PR: ${state.pr}`);
    else if (state.owner === "human-owned") add(`Branch ${state.branch} passed every gate. It is ready for your PR.`);
    if (state.build?.criteria?.length) add("", criteriaTable(state.build.criteria));
    if (state.verified && state.changed !== false) add("", "Verification:", ...state.verified.results.map(checkLine));
    const should = (state.reviewed?.findings ?? []).filter((f) => f.severity === "should");
    if (state.reviewed && state.changed !== false) add("", `Review (${state.reviewed.reviews.join(", ")}): 0 must, ${should.length} should`, ...should.map(findingLine));
  } else if (state.wait) {
    add(state.wait.reason);
    if (state.wait.detail) add("", state.wait.detail);
    if (state.status === "waiting-human") add("", "Run `botalot next` when you have done it.");
    if (state.status === "waiting-you") add("", "Run `botalot next` once it is answered or fixed.");
    if (state.status === "paused-quota") add("", "Run `botalot next` after the usage window resets.");
  } else if (state.stopped) add(state.stopped);
  return lines.join("\n");
}
