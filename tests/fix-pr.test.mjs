// The fix-pr workflow: a round of fixes and answers on an open pull request, against a fake GitHub and a fake agent.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { due } from "../cli/lib/board.mjs";
import { readContract } from "../cli/lib/contract.mjs";
import { continueRun, startRun } from "../cli/lib/driver.mjs";
import { summary } from "../cli/lib/report.mjs";
import { CLEAN_REVIEW, DONE, makeWorld, quiet } from "./helpers.mjs";

const workflows = { workflows: ["implement", "fix-pr"] };
const FAILED = [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://example.test/runs/7" }];
const fixRun = (world) => startRun({ cwd: world.repo, workflow: "fix-pr", ticket: 12, say: quiet });
const dueNow = (world) => due(world.repo, readContract(world.repo).contract).map((d) => `${d.workflow} #${d.number} ${d.branch ?? ""}`.trim());

/** Change the one pull request in the fake GitHub. */
function editPr(change) {
  const path = process.env.FAKE_GH_STATE;
  const gh = JSON.parse(readFileSync(path, "utf8"));
  change(gh.prs[0]);
  writeFileSync(path, JSON.stringify(gh));
}

const thread = (id, body) => ({ isResolved: false, comments: { nodes: [{ databaseId: id, author: { login: "paige" }, path: "feature.txt", line: 1, body }] } });

/** A world whose ticket has been implemented: an open pull request on its branch, the ticket in review. */
async function withPr(fixTurns) {
  const world = makeWorld({ contract: workflows, agent: { build: [{ write: { "feature.txt": "one\n" }, output: DONE }], review: [{ output: CLEAN_REVIEW }, { output: CLEAN_REVIEW }], fix: fixTurns } });
  const built = await startRun({ cwd: world.repo, workflow: "implement", ticket: 12, say: quiet });
  assert.equal(built.status, "done");
  return world;
}

test("a fix round fixes, verifies, reviews, pushes one commit and answers every item", async () => {
  const items = [
    { id: "check-1", verdict: "fixed", reply: "The lint error is gone." },
    { id: "thread-1", verdict: "fixed", reply: "Renamed as asked." },
    { id: "comment-1", verdict: "out-of-scope", reply: "That is a new feature; worth its own ticket." },
  ];
  const world = await withPr([{ write: { "feature.txt": "two\n" }, output: { status: "done", summary: "Fixes lint and the name.", commitMessage: "fix: tidy the feature", items } }]);
  assert.deepEqual(dueNow(world), [], "a pull request with nothing wrong is not due");

  editPr((pr) => {
    pr.checks = FAILED;
    pr.threads = [thread(501, "Please rename this.")];
    pr.comments = [{ author: { login: "paige" }, authorAssociation: "OWNER", body: "Can it also do X?" }, { author: { login: "deploy" }, authorAssociation: "NONE", body: "Preview is ready." }];
  });
  assert.deepEqual(dueNow(world), ["fix-pr #12 12-add-the-feature"]);

  const state = await fixRun(world);
  assert.equal(state.status, "done", summary(state));

  const prompt = world.prompts().find((p) => p.step === "fix").prompt;
  assert.match(prompt, /## check-1: the check "lint" failed[\s\S]*## thread-1: a review thread on feature\.txt:1[\s\S]*> Please rename this\.[\s\S]*## comment-1: a comment on the pull request/);
  assert.doesNotMatch(prompt, /Preview is ready/, "a comment by someone who can't write to the repo is not feedback");

  const log = world.git("log", "--format=%s", "origin/main..origin/12-add-the-feature").split("\n");
  assert.deepEqual(log, ["fix: tidy the feature", "feat: add the feature"], "one new commit on top; the first is untouched");
  assert.match(world.git("log", "-1", "--format=%b", "origin/12-add-the-feature"), /Refs #12/);

  const pr = world.gh().prs[0];
  const commit = world.git("rev-parse", "--short=7", "HEAD");
  assert.equal(pr.threads[0].comments.nodes.at(-1).body, `Fixed in ${commit}. Renamed as asked.\n\n<!-- botalot -->`);
  const round = pr.comments.at(-1).body;
  assert.match(round, /^## Fix round[\s\S]*Check `lint`: \*\*Fixed\.\*\*[\s\S]*Comment by paige: \*\*Out of scope\.\*\*[\s\S]*node check\.mjs`: passed[\s\S]*<!-- botalot -->$/);
  assert.deepEqual(world.issue().labels, ["factory:agent-owned", "factory:in-review"], "the ticket stays in review: merging is the human's");

  editPr((p) => (p.checks = []));
  assert.deepEqual(dueNow(world), [], "everything is answered, so nothing is due");
  editPr((p) => p.threads[0].comments.nodes.push({ databaseId: 502, author: { login: "paige" }, body: "Still not right." }));
  assert.deepEqual(dueNow(world), ["fix-pr #12 12-add-the-feature"], "a new word on a thread makes it due again");
});

test("a round that only pushes back changes no code, skips the gates and still answers", async () => {
  const world = await withPr([{ output: { status: "done", items: [{ id: "thread-1", verdict: "push-back", reply: "The ticket asks for this name." }] } }]);
  editPr((pr) => (pr.threads = [thread(501, "Please rename this.")]));
  const before = world.git("rev-parse", "origin/12-add-the-feature");
  const state = await fixRun(world);

  assert.equal(state.status, "done", summary(state));
  assert.equal(world.git("rev-parse", "origin/12-add-the-feature"), before, "nothing was pushed");
  assert.deepEqual(world.events(state.id).filter((e) => e.event === "step-skip").map((e) => e.step), ["verify", "review", "squash", "push"]);
  assert.equal(world.gh().prs[0].threads[0].comments.nodes.at(-1).body, "The ticket asks for this name.\n\n<!-- botalot -->");
  assert.match(world.gh().prs[0].comments.at(-1).body, /No code changed this round/);
});

test("the driver holds the agent to its word: every item answered, and fixed means a change", async () => {
  const world = await withPr([
    { output: { status: "done", items: [] } },
    { output: { status: "done", items: [{ id: "thread-1", verdict: "fixed", reply: "Done." }] } },
    { output: { status: "done", items: [{ id: "thread-1", verdict: "fixed", reply: "Done." }] } },
  ]);
  editPr((pr) => (pr.threads = [thread(501, "Please rename this.")]));
  const state = await fixRun(world);

  assert.equal(state.status, "waiting-you");
  assert.match(state.wait.detail, /You called thread-1 fixed, but no file changed/);
  assert.match(world.prompts().filter((p) => p.step === "fix")[1].prompt, /Every item needs a verdict and a reply\. Missing: thread-1/);
  assert.equal(world.gh().prs[0].threads[0].comments.nodes.length, 1, "nothing was answered");
});

test("a pull request with nothing to fix ends the run at once, and one with checks running is left alone", async () => {
  const world = await withPr([]);
  const idle = await fixRun(world);
  assert.equal(idle.status, "done");
  assert.match(summary(idle), /has no failing check and nothing unanswered/);
  assert.equal(world.prompts().filter((p) => p.step === "fix").length, 0, "no agent ran");

  editPr((pr) => (pr.checks = [...FAILED, { name: "test", status: "IN_PROGRESS", conclusion: "" }]));
  assert.deepEqual(dueNow(world), [], "not due while a check is still running");
  assert.match((await fixRun(world)).stopped, /still has 1 check\(s\) running/);
});

test("after three rounds the next one asks first", async () => {
  const pushBack = (n) => ({ output: { status: "done", items: [{ id: "thread-1", verdict: "push-back", reply: `No, round ${n}.` }] } });
  const world = await withPr([1, 2, 3, 4].map(pushBack));
  const ids = new Set();
  for (const n of [1, 2, 3]) {
    editPr((pr) => (pr.threads = [thread(500 + n, "Please rename this.")]));
    const round = await fixRun(world);
    assert.equal(round.status, "done");
    ids.add(round.id);
  }
  assert.equal(ids.size, 3, "runs started in the same second still get ids of their own");
  editPr((pr) => (pr.threads = [thread(504, "Please rename this.")]));
  const fourth = await fixRun(world);
  assert.equal(fourth.status, "waiting-you");
  assert.match(fourth.wait.detail, /has had 3 fix rounds and still has 1 item\(s\)/);
  assert.ok(world.issue().labels.includes("factory:needs-you"));

  assert.equal((await continueRun(fourth, { say: quiet })).status, "done", "carrying on gives it another round");
});
