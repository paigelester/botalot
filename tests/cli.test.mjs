// The command itself, run as a repo would run it. The other tests call the library, so only this one
// notices when the entry file doesn't load.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../cli/lib/exec.mjs";
import { BRAIN_VERSION } from "../cli/lib/paths.mjs";
import { makeWorld } from "./helpers.mjs";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "botalot.mjs");
const botalot = (cwd, ...args) => run(process.execPath, [bin, ...args], { cwd });

test("the command loads and prints its help", () => {
  const world = makeWorld();
  const help = botalot(world.repo, "--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, new RegExp(`^botalot ${BRAIN_VERSION.replaceAll(".", "\\.")}`));
  assert.match(help.stdout, /botalot setup/);
});

test("check passes on a good contract, and an unknown command fails with the help", () => {
  const world = makeWorld();
  const check = botalot(world.repo, "check");
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, /The contract passes/);

  const wrong = botalot(world.repo, "launch");
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /"launch" is not a botalot command/);
});

test("setup run from the command leaves an existing contract alone and sets the labels", () => {
  const world = makeWorld();
  const setup = botalot(world.repo, "setup");
  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, /already exists; left as it is\.\nThe contract passes\.\nLabels set on GitHub/);
});
