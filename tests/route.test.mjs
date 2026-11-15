// The route workflow, the board and what is due, against a fake GitHub and a fake agent.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { board, due } from "../cli/lib/board.mjs";
import { readContract } from "../cli/lib/contract.mjs";
import { startRun } from "../cli/lib/driver.mjs";
import { summary } from "../cli/lib/report.mjs";
import { approve, pick } from "../cli/lib/tickets.mjs";
import { makeWorld, quiet } from "./helpers.mjs";

const both = { workflows: ["implement", "route"] };
const judged = (risk, solvability) => ({ status: "done", approach: ["Add the file."], risk, riskReasons: ["Contained."], solvability, solvabilityReasons: [], areas: ["greeting"] });
const route = (world) => startRun({ cwd: world.repo, workflow: "route", ticket: 12, say: quiet });

/** Add a second open ticket to the fake GitHub. */
function addIssue(world, number, labels) {
  const path = process.env.FAKE_GH_STATE;
  const gh = JSON.parse(readFileSync(path, "utf8"));
  gh.issues[number] = { number, title: `Ticket ${number}`, body: "", labels, comments: [] };
  writeFileSync(path, JSON.stringify(gh));
}

test("routing posts the plan and the owner label, and leaves the ticket for the human to approve", async () => {
  const world = makeWorld({ labels: ["factory:selected"], contract: both, agent: { route: [{ output: judged("low", "yes") }] } });
  const before = world.git("rev-parse", "HEAD");
  const state = await route(world);

  assert.equal(state.status, "done");
  assert.equal(state.kind, "planning");
  assert.deepEqual(world.issue().labels, ["factory:selected", "factory:agent-owned"], "still selected: ready is the human's move");
  assert.match(world.issue().comments[0], /^## Routing plan\n\n\*\*Owner:\*\* agent-owned \(rule: risk low, solvability yes\)[\s\S]*### Approach\n- Add the file\.[\s\S]*- nothing only a human has/);
  assert.match(summary(state), /Routed #12: agent-owned[\s\S]*botalot approve 12/);
  assert.equal(world.git("rev-parse", "--abbrev-ref", "HEAD"), "main", "routing needs no branch");
  assert.equal(world.git("rev-parse", "HEAD"), before);
  assert.deepEqual(world.prompts()[0].settings.permissions.deny, ["Edit", "Write", "NotebookEdit"], "the router only reads");
});

test("the owner is picked by rule, whatever the agent thinks", async () => {
  for (const [risk, solvability, owner] of [["medium", "yes", "agent-owned"], ["high", "yes", "human-owned"], ["low", "partly", "human-owned"], ["low", "no", "human-owned"]]) {
    const world = makeWorld({ labels: ["factory:selected"], contract: both, agent: { route: [{ output: { ...judged(risk, solvability), owner: "agent-owned" } }] } });
    await route(world);
    assert.ok(world.issue().labels.includes(`factory:${owner}`), `${risk}/${solvability} should be ${owner}`);
  }
});

test("a ticket that can't be routed is flagged, and one that isn't selected or is already routed is refused", async () => {
  const unclear = makeWorld({ labels: ["factory:selected"], contract: both, agent: { route: [{ output: { status: "needs-human", kind: "decision", question: "What should criterion 2 be?" } }] } });
  const waiting = await route(unclear);
  assert.equal(waiting.status, "waiting-you");
  assert.deepEqual(unclear.issue().labels, ["factory:selected", "factory:needs-you"]);
  assert.match(unclear.issue().comments[0], /What should criterion 2 be\?/);

  assert.match((await route(makeWorld({ labels: ["factory:refined"], contract: both }))).stopped, /not at factory:selected/);
  assert.match((await route(makeWorld({ labels: ["factory:selected", "factory:human-owned"], contract: both }))).stopped, /already has an owner/);
});

test("approving moves a routed ticket to ready, and refuses one that has not been routed", async () => {
  const world = makeWorld({ labels: ["factory:selected"], contract: both, agent: { route: [{ output: judged("low", "yes") }] } });
  assert.throws(() => approve(world.repo, 12), /has no owner yet/);
  await route(world);
  assert.equal(approve(world.repo, 12), "#12 is ready, agent-owned.");
  assert.deepEqual(world.issue().labels, ["factory:agent-owned", "factory:ready"]);
  assert.equal(approve(world.repo, 12), "#12 is already ready.");
});

test("picking moves a refined ticket to selected: the one named, or the oldest that isn't flagged", () => {
  const world = makeWorld({ labels: ["factory:refined", "factory:blocked"] });
  addIssue(world, 30, ["factory:refined"]);
  addIssue(world, 31, ["factory:refined"]);
  addIssue(world, 32, ["factory:new"]);

  assert.equal(pick(world.repo), "#30 is selected: Ticket 30");
  assert.deepEqual(world.gh().issues[30].labels, ["factory:selected"]);
  assert.equal(pick(world.repo, 12), "#12 is selected: Add the feature!", "naming a ticket overrules the flag");
  assert.equal(pick(world.repo, 12), "#12 is already selected.");
  assert.throws(() => pick(world.repo, 32), /not at factory:refined/);
  assert.equal(pick(world.repo), "#31 is selected: Ticket 31");
  assert.throws(() => pick(world.repo), /No refined ticket is waiting/);
});

test("the board groups the tickets waiting on the human, and carries the plan to approve", async () => {
  const world = makeWorld({ labels: ["factory:selected"], contract: both, agent: { route: [{ output: judged("high", "yes") }] } });
  await route(world);
  addIssue(world, 20, ["factory:ready", "factory:human-owned"]);
  addIssue(world, 21, ["factory:in-progress", "factory:agent-owned", "factory:needs-you"]);
  addIssue(world, 22, ["factory:in-review", "factory:agent-owned"]);
  addIssue(world, 23, ["factory:refined"]);
  const b = board(world.repo);

  assert.deepEqual(b.toApprove.map((t) => [t.number, t.owner]), [[12, "human-owned"]]);
  assert.match(b.toApprove[0].plan, /^## Routing plan[\s\S]*### Risk: high/);
  assert.deepEqual(b.yoursToBuild.map((t) => t.number), [20]);
  assert.deepEqual(b.needsYou.map((t) => t.number), [21]);
  assert.deepEqual(b.inReview.map((t) => t.number), [22]);
  assert.deepEqual(b.refined.map((t) => t.number), [23]);
});

test("what is due follows each workflow's trigger, oldest first, skipping flagged tickets and tickets with a run", async () => {
  const world = makeWorld({ labels: ["factory:selected"], contract: both });
  addIssue(world, 5, ["factory:ready", "factory:agent-owned"]);
  addIssue(world, 6, ["factory:ready", "factory:human-owned"]);
  addIssue(world, 7, ["factory:selected", "factory:agent-owned"]);
  addIssue(world, 8, ["factory:selected", "factory:needs-you"]);
  addIssue(world, 9, ["factory:ready", "factory:agent-owned", "factory:blocked"]);
  const { contract } = readContract(world.repo);

  assert.deepEqual(due(world.repo, contract).map((d) => `${d.workflow} #${d.number} ${d.kind} ${d.where}`), ["implement #5 work holding", "route #12 planning main"]);
  assert.deepEqual(due(world.repo, { ...contract, workflows: ["implement"] }).map((d) => d.number), [5], "a workflow the contract doesn't turn on is never due");

  await startRun({ cwd: world.repo, workflow: "implement", ticket: 6, say: quiet });
  addIssue(world, 6, ["factory:ready", "factory:agent-owned"]);
  assert.ok(!due(world.repo, contract).some((d) => d.number === 6), "a ticket with an open run is left alone");
});
