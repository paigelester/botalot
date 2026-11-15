import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contractProblems } from "../cli/lib/contract.mjs";
import { BRAIN_VERSION } from "../cli/lib/paths.mjs";
import { draftContract, setupRepo } from "../cli/lib/setup.mjs";
import { makeWorld } from "./helpers.mjs";

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "botalot-setup-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}

test("a drafted contract takes its checks and stacks from the repo, and is well formed", () => {
  const repo = folder({
    "package.json": { scripts: { dev: "next dev", build: "next build", lint: "eslint", test: "vitest run", "test:watch": "vitest" }, dependencies: { next: "16" }, devDependencies: { typescript: "5", botalot: "x" } },
    "package-lock.json": "{}",
  });
  const { contract, notes } = draftContract(repo);

  assert.deepEqual(contract.stacks, ["typescript", "nextjs"]);
  assert.deepEqual(contract.commands, { setup: ["npm install"], verify: ["npm run lint", "npm run test", "npm run build"], run: "npm run dev" });
  assert.equal(contract.botalot, BRAIN_VERSION);
  assert.deepEqual(contractProblems(contract), []);
  assert.deepEqual(notes, []);
});

test("one verify script wins over the separate checks, and the lockfile picks the package manager", () => {
  const repo = folder({ "package.json": { scripts: { verify: "x", lint: "y", start: "z" } }, "pnpm-lock.yaml": "", "tsconfig.json": "{}" });
  const { contract, notes } = draftContract(repo);

  assert.deepEqual(contract.commands, { setup: ["pnpm install"], verify: ["pnpm run verify"], run: "pnpm run start" });
  assert.deepEqual(contract.stacks, ["typescript"]);
  assert.match(notes.join("\n"), /botalot is not a dev dependency here[\s\S]*pnpm add -D github:paigelester\/botalot#v/);
});

test("a repo with nothing to read gets a contract that says what is missing, never invented checks", () => {
  const { contract, notes } = draftContract(folder({}));
  assert.deepEqual(contract.commands, { verify: [] });
  assert.deepEqual(contract.stacks, []);
  assert.match(notes.join("\n"), /no package\.json[\s\S]*No known stack/);
});

test("setup writes the contract and the labels, and never overwrites a contract that is there", () => {
  const world = makeWorld();
  const before = readFileSync(join(world.repo, ".factory", "contract.json"), "utf8");
  const kept = setupRepo(world.repo);
  assert.ok(kept.ok);
  assert.match(kept.lines.join("\n"), /already exists; left as it is[\s\S]*The contract passes[\s\S]*Labels set on GitHub: factory:new/);
  assert.equal(readFileSync(join(world.repo, ".factory", "contract.json"), "utf8"), before);
  assert.equal(world.gh().labels.length, 10);

  world.git("rm", "-q", "-r", ".factory");
  writeFileSync(join(world.repo, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
  const fresh = setupRepo(world.repo);
  assert.ok(fresh.ok);
  assert.ok(existsSync(join(world.repo, ".factory", "contract.json")));
  assert.match(fresh.lines.join("\n"), /Wrote \.factory\/contract\.json[\s\S]*checks: npm run test[\s\S]*already on GitHub/);
});

test("setup says the repo is not ready when the drafted contract has no checks", () => {
  const world = makeWorld();
  world.git("rm", "-q", "-r", ".factory");
  const result = setupRepo(world.repo, { labels: false });
  assert.equal(result.ok, false);
  assert.match(result.lines.join("\n"), /does not pass yet[\s\S]*"commands\.verify" must be a list of commands/);
});
