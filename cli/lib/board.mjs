// What is waiting, read off a repo's tickets: the board (waiting on the human) and what is due (waiting on a run).
import { loadWorkflow } from "./brain.mjs";
import { mainCheckout } from "./git.mjs";
import { OPEN_STATUSES, allStates } from "./runs.mjs";
import { OWNER_LABELS, listPrs, listTickets, prFeedback, prForTicket, routingPlan } from "./tickets.mjs";

const has = (ticket, label) => ticket.labels.includes(label);
const owner = (ticket) => ticket.labels.map((l) => OWNER_LABELS[l]).find(Boolean) ?? null;
const brief = (t) => ({ number: t.number, title: t.title, url: t.url });

/**
 * A repo's board: the tickets waiting on the human, grouped by what they need.
 *   toApprove      routed (selected, with an owner): approve to make it ready. Carries the plan.
 *   needsYou       a run asked a question or got blocked
 *   yoursToBuild   ready and human-owned
 *   inReview       a pull request is open
 */
export function board(repo) {
  const tickets = listTickets(repo);
  return {
    toApprove: tickets.filter((t) => has(t, "factory:selected") && owner(t)).map((t) => ({ ...brief(t), owner: owner(t), plan: routingPlan(repo, t.number) })),
    needsYou: tickets.filter((t) => has(t, "factory:needs-you")).map(brief),
    yoursToBuild: tickets.filter((t) => has(t, "factory:ready") && has(t, "factory:human-owned")).map(brief),
    inReview: tickets.filter((t) => has(t, "factory:in-review")).map(brief),
  };
}

/**
 * The runs that should be started: each open ticket whose labels match the trigger of a workflow the
 * contract turns on, oldest first. A ticket that already has an open run, or is flagged as needing a
 * human or blocked, is left alone.
 */
export function due(repo, contract) {
  const main = mainCheckout(repo);
  const busy = new Set(allStates().filter((s) => OPEN_STATUSES.includes(s.status) && (s.mainRepo ?? s.repo) === main).map((s) => s.ticket));
  const tickets = listTickets(repo).filter((t) => !busy.has(t.number) && !has(t, "factory:needs-you") && !has(t, "factory:blocked"));
  const out = [];
  let prs = null;
  for (const name of contract.workflows ?? []) {
    const workflow = loadWorkflow(name);
    const trigger = workflow.trigger;
    if (!trigger) continue;
    for (const t of tickets) {
      if (!trigger.labels.every((l) => has(t, l)) || (trigger.without ?? []).some((l) => has(t, l))) continue;
      const entry = { workflow: name, kind: workflow.kind ?? "work", where: workflow.where ?? "holding", ...brief(t) };
      if (trigger.pr === "needs-work") {
        const pr = prForTicket(repo, t.number, (prs ??= listPrs(repo)));
        if (!pr || !prNeedsWork(repo, pr)) continue;
        // The run belongs on the pull request's own branch, not one named afresh from the ticket.
        entry.branch = pr.branch;
      }
      out.push(entry);
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Whether a pull request has something to fix or answer. Not while its checks are still running: wait for the whole picture. */
function prNeedsWork(repo, pr) {
  if (pr.checks.pending) return false;
  if (pr.checks.failing.length) return true;
  const feedback = prFeedback(repo, pr.number);
  return feedback.threads.length + feedback.comments.length > 0;
}
