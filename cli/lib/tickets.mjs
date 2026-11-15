// GitHub Issues and pull requests, through the `gh` CLI. A ticket's state is its factory:* labels.
import { must, run, toolCommand } from "./exec.mjs";
import { LABELS, RETIRED_LABELS } from "./brain.mjs";

const gh = () => toolCommand("BOTALOT_GH_CMD", "gh");
const call = (repo, ...args) => must(gh(), args, { cwd: repo });

export const OWNER_LABELS = { "factory:agent-owned": "agent-owned", "factory:human-owned": "human-owned" };

/** The ticket with its comments, and the two things the driver reads off its labels. */
export function readTicket(repo, number) {
  const json = call(repo, "issue", "view", String(number), "--json", "number,title,body,state,url,labels,assignees,comments");
  const issue = JSON.parse(json);
  const labels = (issue.labels ?? []).map((l) => l.name);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    url: issue.url,
    labels,
    assignees: (issue.assignees ?? []).map((a) => a.login),
    comments: (issue.comments ?? []).map((c) => ({ author: c.author?.login ?? "unknown", body: c.body })),
    owner: labels.map((l) => OWNER_LABELS[l]).find(Boolean) ?? null,
  };
}

export function relabel(repo, number, remove, add) {
  const args = ["issue", "edit", String(number)];
  for (const label of remove) args.push("--remove-label", label);
  for (const label of add) args.push("--add-label", label);
  if (args.length > 3) call(repo, ...args);
}

/** Every open ticket, with its labels. */
export function listTickets(repo) {
  const json = call(repo, "issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,url,labels");
  return JSON.parse(json).map((i) => ({ number: i.number, title: i.title, url: i.url, labels: (i.labels ?? []).map((l) => l.name) }));
}

/** The latest routing plan posted on a ticket, or null. */
export function routingPlan(repo, number) {
  const plans = readTicket(repo, number).comments.filter((c) => c.body.trimStart().startsWith("## Routing plan"));
  return plans.length ? plans.at(-1).body : null;
}

/** The human's approval of a routed ticket: selected becomes ready. Refused unless it has been routed. */
export function approve(repo, number) {
  const ticket = readTicket(repo, number);
  if (ticket.labels.includes("factory:ready")) return `#${number} is already ready.`;
  if (!ticket.labels.includes("factory:selected")) throw new Error(`#${number} is not at factory:selected, so there is nothing to approve.`);
  if (!ticket.owner) throw new Error(`#${number} has no owner yet. Route it first: \`botalot start route ${number}\`.`);
  relabel(repo, number, ["factory:selected"], ["factory:ready"]);
  return `#${number} is ready, ${ticket.owner}.`;
}

export const assignToMe = (repo, number) => call(repo, "issue", "edit", String(number), "--add-assignee", "@me");
export const comment = (repo, number, body) => call(repo, "issue", "comment", String(number), "--body", body);

/** The person to ping: the ticket's assignee, else whoever owns the repo. */
export function humanFor(repo, ticket) {
  if (ticket.assignees.length) return ticket.assignees[0];
  const result = run(gh(), ["repo", "view", "--json", "owner", "--jq", ".owner.login"], { cwd: repo });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Open a ready-for-review PR and return its URL. */
export function openPr(repo, { title, bodyFile, base, head }) {
  const out = call(repo, "pr", "create", "--title", title, "--body-file", bodyFile, "--base", base, "--head", head);
  return out.split("\n").filter(Boolean).pop();
}

/** The open PR for a branch, or null. */
export function prForBranch(repo, branch) {
  const result = run(gh(), ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], { cwd: repo });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** Ends everything botalot writes on a pull request, so its own answers are never read as new feedback. */
export const MARK = "<!-- botalot -->";

const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/** A pull request's checks as GitHub rolls them up: the ones that failed, and how many are still running. */
function readChecks(rollup) {
  const failing = [];
  let pending = 0;
  for (const c of rollup ?? []) {
    // A check run has status and conclusion; an older commit status has only state.
    const result = c.conclusion || c.state || "";
    const running = c.status ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(result);
    if (running) pending++;
    else if (FAILED.includes(result)) failing.push({ name: c.name ?? c.context ?? "check", url: c.detailsUrl ?? c.targetUrl ?? "" });
  }
  return { failing, pending };
}

/** Every open pull request, with its branch, the tickets its body closes, and its checks. */
export function listPrs(repo) {
  const json = call(repo, "pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,headRefName,body,statusCheckRollup");
  return JSON.parse(json).map((pr) => ({
    number: pr.number,
    url: pr.url,
    branch: pr.headRefName,
    closes: [...(pr.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1])),
    checks: readChecks(pr.statusCheckRollup),
  }));
}

/** The open pull request for a ticket: the one whose body closes it, else the one on the ticket's branch. */
export function prForTicket(repo, number, prs = listPrs(repo)) {
  return prs.find((pr) => pr.closes.includes(number)) ?? prs.find((pr) => pr.branch.startsWith(`${number}-`)) ?? null;
}

const FEEDBACK_QUERY =
  "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){" +
  "reviewThreads(first:100){nodes{isResolved comments(first:50){nodes{databaseId author{login} path line body}}}} " +
  "comments(last:50){nodes{author{login} authorAssociation body}}}}}";

/**
 * What on a pull request still needs an answer.
 *   threads    review threads that are not resolved and whose last word is not botalot's
 *   comments   comments on the pull request itself, by someone who can write to the repo, since botalot last answered
 */
export function prFeedback(repo, number) {
  const json = call(repo, "api", "graphql", "-f", `query=${FEEDBACK_QUERY}`, "-F", "o={owner}", "-F", "r={repo}", "-F", `n=${number}`);
  const pr = JSON.parse(json).data.repository.pullRequest;
  const said = (c) => ({ author: c.author?.login ?? "unknown", body: c.body ?? "" });
  const threads = [];
  for (const t of pr.reviewThreads.nodes) {
    const comments = t.comments.nodes;
    if (t.isResolved || comments.length === 0 || comments.at(-1).body.includes(MARK)) continue;
    threads.push({ replyTo: comments[0].databaseId, path: comments[0].path ?? "", line: comments[0].line ?? null, comments: comments.map(said) });
  }
  const all = pr.comments.nodes;
  const lastAnswer = all.map((c) => c.body.includes(MARK)).lastIndexOf(true);
  const comments = all.slice(lastAnswer + 1).filter((c) => ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.authorAssociation)).map(said);
  return { threads, comments };
}

export const replyToThread = (repo, pr, commentId, body) => call(repo, "api", `repos/{owner}/{repo}/pulls/${pr}/comments/${commentId}/replies`, "-f", `body=${body}\n\n${MARK}`);
export const commentOnPr = (repo, pr, body) => call(repo, "pr", "comment", String(pr), "--body", `${body}\n\n${MARK}`);

/**
 * Compare the repo's labels with the ten the factory uses. With `fix`, create or correct them.
 * With `prune`, also delete the labels retired in the cut from 21 to 10. Returns what it found and did.
 */
export function syncLabels(repo, { fix = false, prune = false } = {}) {
  const existing = JSON.parse(call(repo, "label", "list", "--limit", "500", "--json", "name,color,description"));
  const byName = new Map(existing.map((l) => [l.name, l]));
  const report = { missing: [], set: [], retired: [], pruned: [] };
  for (const [name, color, description] of LABELS) {
    const have = byName.get(name);
    if (have && have.color.toLowerCase() === color && have.description === description) continue;
    report.missing.push(name);
    if (fix) {
      call(repo, "label", "create", name, "--color", color, "--description", description, "--force");
      report.set.push(name);
    }
  }
  for (const name of RETIRED_LABELS) {
    if (!byName.has(name)) continue;
    report.retired.push(name);
    if (prune) {
      call(repo, "label", "delete", name, "--yes");
      report.pruned.push(name);
    }
  }
  return report;
}
