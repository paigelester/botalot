import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readKnowledge } from "../cli/lib/brain.mjs";
import { trySkill } from "../cli/lib/driver.mjs";
import { knowledgeIndex, writeKnowledgeIndex } from "../cli/lib/knowledge.mjs";
import { CLEAN_REVIEW, makeWorld } from "./helpers.mjs";

const contract = { stacks: ["typescript"] };

test("the index lists each file the contract loads with its label, by a path inside the repo", () => {
  const world = makeWorld();
  const index = knowledgeIndex(world.repo, contract, join(world.repo, "node_modules", "botalot"));

  assert.match(index, /- Writing or changing tests: `node_modules\/botalot\/knowledge\/fundamentals\/testing\.md`/);
  assert.match(index, /- Writing TypeScript: `node_modules\/botalot\/knowledge\/stacks\/typescript\.md`/);
  assert.doesNotMatch(index, /nextjs/, "a stack the contract doesn't name is left out");
  assert.doesNotMatch(index, /rubrics/, "rubrics are for reviews, not for sessions");
});

test("no index is written when botalot lives outside the repo", () => {
  const world = makeWorld();
  assert.equal(knowledgeIndex(world.repo, contract), null);
  assert.equal(writeKnowledgeIndex(world.repo, contract).status, "skipped");
});

test("writing the index keeps the rest of the file, and writing it again changes nothing", () => {
  const world = makeWorld();
  const brain = join(world.repo, "node_modules", "botalot");
  const file = join(world.repo, "CLAUDE.md");
  writeFileSync(file, "# Rules\n\nMine.\n");

  assert.deepEqual(writeKnowledgeIndex(world.repo, contract, brain), { status: "written", file: "CLAUDE.md" });
  assert.match(readFileSync(file, "utf8"), /^# Rules\n\nMine\.\n\n<!-- BEGIN:botalot-knowledge -->[\s\S]*<!-- END:botalot-knowledge -->\n$/);
  assert.equal(writeKnowledgeIndex(world.repo, contract, brain).status, "unchanged");

  writeFileSync(file, readFileSync(file, "utf8") + "\n## After\n");
  assert.equal(writeKnowledgeIndex(world.repo, { stacks: ["typescript", "nextjs"] }, brain).status, "updated");
  const text = readFileSync(file, "utf8");
  assert.match(text, /nextjs\.md/);
  assert.match(text, /^# Rules[\s\S]*## After\n$/, "text before and after the block is untouched");
  assert.equal(text.match(/BEGIN:botalot-knowledge/g).length, 1);
});

test("a step is given knowledge without its label", () => {
  const text = readKnowledge(["fundamentals"], contract);
  assert.match(text, /# Testing/);
  assert.doesNotMatch(text, /^when:/m);
});

test("trying a skill dry prints its prompt and starts no agent", async () => {
  const world = makeWorld();
  const result = await trySkill({ cwd: world.repo, skill: "build", ticket: 12, dry: true });
  assert.match(result.prompt, /# Step: build[\s\S]*knowledge\/stacks\/typescript\.md[\s\S]*Ticket #12: Add the feature!/);
  assert.equal(world.prompts().length, 0);
});

test("trying a skill runs it alone: no label moves, nothing is committed", async () => {
  const world = makeWorld({ agent: { "review-code": [{ output: CLEAN_REVIEW }] } });
  world.write("feature.txt", "hello\n");
  const before = world.git("rev-parse", "HEAD");
  const result = await trySkill({ cwd: world.repo, skill: "review-code" });

  assert.ok(result.ok);
  assert.deepEqual(result.output, CLEAN_REVIEW);
  assert.equal(result.session, "fake-review-code-1");
  assert.match(world.prompts()[0].prompt, /no ticket: this is a test of the skill[\s\S]*- feature\.txt/);
  assert.deepEqual(world.issue().labels, ["factory:ready", "factory:agent-owned"]);
  assert.equal(world.git("rev-parse", "HEAD"), before);
  await assert.rejects(trySkill({ cwd: world.repo, skill: "create-tickets" }), /is not a step skill/);
});
