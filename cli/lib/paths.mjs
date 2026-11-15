// Where things live: the brain (this repo, wherever it is installed) and botalot's home (run logs and state).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The root of the botalot package this driver ships in: the repo, or its copy in a repo's node_modules. */
export const BRAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The brain's version, from its package.json. A repo's contract pins this. */
export const BRAIN_VERSION = JSON.parse(readFileSync(join(BRAIN, "package.json"), "utf8")).version;

/** Run logs, run state and the latest quota reading. One folder for every repo, so Botalot watches one place. */
export function botalotHome() {
  return process.env.BOTALOT_HOME || join(homedir(), ".botalot");
}

export function runsDir() {
  return join(botalotHome(), "runs");
}
