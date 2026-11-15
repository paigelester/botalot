// The knowledge index: a short block in a repo's agent instructions that lists each knowledge file with a
// label saying when to read it. A session reads the labels and opens a file only when the task fits, so
// knowledge costs a few lines until it is needed. (Runs don't use the index: the driver hands each step its files.)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { knowledgeFiles, knowledgeLabel } from "./brain.mjs";
import { BRAIN } from "./paths.mjs";

const BEGIN = "<!-- BEGIN:botalot-knowledge -->";
const END = "<!-- END:botalot-knowledge -->";

/** The file the index goes in: the repo's CLAUDE.md, else its AGENTS.md, else a new CLAUDE.md. */
export function indexFile(repo) {
  if (existsSync(join(repo, "CLAUDE.md"))) return "CLAUDE.md";
  if (existsSync(join(repo, "AGENTS.md"))) return "AGENTS.md";
  return "CLAUDE.md";
}

/**
 * The index block for a repo, or null when botalot doesn't live inside the repo (a global install or the
 * app's copy): its path would then be this machine's, which must not be committed. `brain` is where botalot is.
 */
export function knowledgeIndex(repo, contract, brain = BRAIN) {
  const rel = relative(repo, brain);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const prefix = rel ? `${rel.split(sep).join("/")}/` : "";
  const lines = knowledgeFiles(["fundamentals", "stacks"], contract).map((f) => `- ${knowledgeLabel(f)}: \`${prefix}${f}\``);
  return [
    BEGIN,
    "",
    "## How code is written and judged here",
    "",
    "Before writing or reviewing code, read each file below whose label fits the task. They are short. This repo's own rules overrule them.",
    "",
    ...lines,
    "",
    "This block is written by `botalot knowledge --write`. Change the rules in botalot, not here.",
    "",
    END,
  ].join("\n");
}

/** Write or refresh the index block. Returns what happened: written, updated, unchanged, or skipped (with why). */
export function writeKnowledgeIndex(repo, contract, brain = BRAIN) {
  const block = knowledgeIndex(repo, contract, brain);
  const file = indexFile(repo);
  if (!block) return { status: "skipped", file, why: "botalot is not installed inside this repo, so its knowledge has no path that works on other machines" };
  const path = join(repo, file);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const text = block.split("\n").join(eol);
  const start = before.indexOf(BEGIN);
  const end = before.indexOf(END);
  let after;
  if (start >= 0 && end > start) after = before.slice(0, start) + text + before.slice(end + END.length);
  else after = before.trim() ? `${before.trimEnd()}${eol}${eol}${text}${eol}` : `${text}${eol}`;
  if (after === before) return { status: "unchanged", file };
  writeFileSync(path, after);
  return { status: start >= 0 ? "updated" : "written", file };
}
