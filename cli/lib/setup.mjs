// Setting a repo up: drafting its contract from what the repo already says about itself, then the labels.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stackNames } from "./brain.mjs";
import { CONTRACT_FILE, checkContract } from "./contract.mjs";
import { writeKnowledgeIndex } from "./knowledge.mjs";
import { BRAIN_VERSION } from "./paths.mjs";
import { syncLabels } from "./tickets.mjs";

const SCHEMA = "https://raw.githubusercontent.com/paigelester/botalot/main/schemas/contract.schema.json";

/** The package.json scripts that are checks, in the order they should run. */
const CHECK_SCRIPTS = ["lint", "format:check", "typecheck", "test", "build"];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The package manager a repo uses, from its lockfile: how to install and how to run a script. */
function packageManager(repo) {
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return { install: "pnpm install", run: "pnpm run" };
  if (existsSync(join(repo, "yarn.lock"))) return { install: "yarn install", run: "yarn" };
  return { install: "npm install", run: "npm run" };
}

/**
 * A first contract for a repo, read from the repo itself and never guessed: its checks from package.json
 * scripts (one `verify` script wins over the separate ones), its stacks from what it depends on. Returns the
 * contract and notes on anything a person should look at.
 */
export function draftContract(repo) {
  const pkg = readJson(join(repo, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const pm = packageManager(repo);
  const notes = [];

  const found = [];
  if (deps.typescript || existsSync(join(repo, "tsconfig.json"))) found.push("typescript");
  if (deps.next) found.push("nextjs");
  const stacks = found.filter((s) => stackNames().includes(s));

  const commands = {};
  if (pkg) commands.setup = [pm.install];
  const checks = scripts.verify ? ["verify"] : CHECK_SCRIPTS.filter((s) => scripts[s]);
  commands.verify = checks.map((s) => `${pm.run} ${s}`);
  if (scripts.dev) commands.run = `${pm.run} dev`;
  else if (scripts.start) commands.run = `${pm.run} start`;

  if (!pkg) notes.push(`There is no package.json, so no checks were found. Add every check a change must pass to "commands.verify".`);
  else if (commands.verify.length === 0) notes.push(`package.json has no ${CHECK_SCRIPTS.join(", ")} or verify script. Add every check a change must pass to "commands.verify".`);
  if (stacks.length === 0) notes.push(`No known stack was found, so only the fundamentals load. Stacks: ${stackNames().join(", ")}.`);
  if (pkg && !deps.botalot) notes.push(`botalot is not a dev dependency here. To pin it for other machines and cloud agents: ${pm.install === "npm install" ? "npm install --save-dev" : pm.install.replace("install", "add -D")} github:paigelester/botalot#v${BRAIN_VERSION}`);

  const contract = { $schema: SCHEMA, botalot: BRAIN_VERSION, stacks, commands, workflows: ["implement", "route"], reviews: [{ paths: ["**"], run: ["code"] }] };
  return { contract, notes };
}

/** One line saying what happened to the knowledge index. */
export function indexLine({ status, file, why }) {
  if (status === "skipped") return `No knowledge index was written: ${why}.`;
  if (status === "unchanged") return `The knowledge index in ${file} is up to date.`;
  return `${status === "written" ? "Wrote" : "Updated"} the knowledge index in ${file}: sessions here read a rules file only when the task needs it.`;
}

/**
 * Set a repo up: write a contract when it has none (an existing one is never overwritten), check it,
 * write the knowledge index into its agent instructions, and create the factory's labels on GitHub. Returns the lines to print and whether the repo is ready.
 */
export function setupRepo(repo, { labels = true } = {}) {
  const lines = [];
  const path = join(repo, CONTRACT_FILE);
  if (existsSync(path)) lines.push(`${CONTRACT_FILE} already exists; left as it is.`);
  else {
    const { contract, notes } = draftContract(repo);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(contract, null, 2) + "\n");
    lines.push(`Wrote ${CONTRACT_FILE}:`, `  stacks: ${contract.stacks.join(", ") || "(none)"}`, `  checks: ${contract.commands.verify.join(", ") || "(none)"}`);
    for (const note of notes) lines.push(`Note: ${note}`);
  }

  const { contract, problems } = checkContract(repo);
  let ok = problems.length === 0;
  if (ok) lines.push("The contract passes.");
  else lines.push("The contract does not pass yet:", ...problems.map((p) => `- ${p}`));

  if (ok) lines.push(indexLine(writeKnowledgeIndex(repo, contract)));

  if (labels) {
    try {
      const report = syncLabels(repo, { fix: true });
      lines.push(report.set.length ? `Labels set on GitHub: ${report.set.join(", ")}.` : "The factory's labels are already on GitHub.");
      if (report.retired.length) lines.push(`Retired labels are still on the repo: ${report.retired.join(", ")}. \`botalot labels --prune\` deletes them.`);
    } catch (err) {
      ok = false;
      lines.push(`Could not set the labels on GitHub: ${err.message.split("\n")[0]}`, "Sign in with `gh auth login` and check the repo has Issues turned on, then run `botalot labels --fix`.");
    }
  }

  if (ok) lines.push("Next: run `botalot verify` to confirm every check passes on a clean checkout, then commit the contract.");
  return { ok, lines };
}
