// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exitCodes } from "../contract/describe";
import type { MergeResult } from "../mcp/document";
import { NONINTERACTIVE_ENV } from "../terminal/inputMode";
import { JSON_MODE_ENV } from "../terminal/jsonMode";
import { writeFileAtomic } from "./atomic";
import { lstatAsProject } from "./linkView";
import { readFileOutcome } from "./readOptionalFile";

/**
 * **What an agent working in a Pithy project is told, and where (#697).**
 *
 * A fresh project used to carry no instructions for the agent driving it, so the agent learned the CLI by
 * trial: it waited on a prompt, parsed a pretty-printed document, read every failure as exit 1. `pithy
 * init` now writes a marked block into `AGENTS.md` naming the five things that end the guessing, and
 * `pithy upgrade` rewrites that block as the CLI changes. `CLAUDE.md` gets one line importing `AGENTS.md`,
 * because Claude Code reads its own file and not the shared one.
 *
 * **The block is the only part of `AGENTS.md` Pithy owns.** The file is the project's, and agents' rules
 * accumulate there, so a write replaces the lines from the open marker through the close marker and not
 * one byte either side. A file without the block gains it at the end. A file whose markers are ambiguous —
 * an open with no close, two blocks — is refused rather than guessed at, as `pithy docs connect` refuses
 * a document it cannot read (`mcp/connect.ts`), and for the same reason: guessing at the shape of a file
 * somebody edited is how a tool eats an edit.
 *
 * **Not a template file.** `templates/starter` is refused wholesale by `ensureScaffoldable` when any of
 * its files already exists, and `AGENTS.md` is the file a cloned repository is likeliest to carry already.
 * So the content lives here, and both commands merge it.
 *
 * **Nothing here throws.** A refusal is a value with a one-line reason that never quotes the file, so a
 * planted link or a hand-broken marker costs the project its block and not the run that was writing it.
 */

/** The file the block lives in. Read by every agent harness that reads a shared instructions file. */
export const AGENTS_FILE = "AGENTS.md";

/** Claude Code's own file, which gets one line importing {@link AGENTS_FILE}. */
export const CLAUDE_FILE = "CLAUDE.md";

/** What every open marker starts with. Matched by prefix, so the wording after it can change. */
const OPEN_PREFIX = "<!-- pithy:begin";

/** The line the block opens on. An HTML comment, so a rendered `AGENTS.md` shows nothing of it. */
export const BLOCK_OPEN = `${OPEN_PREFIX} — pithy upgrade rewrites this block. Edit outside it. -->`;

/** The line the block closes on. */
export const BLOCK_CLOSE = "<!-- pithy:end -->";

/** What every close marker starts with. */
const CLOSE_PREFIX = "<!-- pithy:end";

/** The import a `CLAUDE.md` already pointing at `AGENTS.md` carries, however it words the rest. */
const AGENTS_IMPORT = `@${AGENTS_FILE}`;

/**
 * `CLAUDE.md`'s one line. `@AGENTS.md` is Claude Code's import syntax, so the file is loaded rather than
 * only named.
 */
export const CLAUDE_POINTER = `Agent instructions for this project, Pithy's included: ${AGENTS_IMPORT}`;

/** What happened to one of the two files. `docs/commands/init.md` and `upgrade.md` publish it. */
export const InstructionsFile = z
  .object({
    path: z.string().describe("The file, relative to the project root: `AGENTS.md` or `CLAUDE.md`."),
    state: z
      .enum(["added", "updated", "unchanged", "linked", "refused"])
      .describe(
        "`added` — the block (or the pointer) was not there and now is; `updated` — the block was stale and was rewritten; `unchanged` — already current, and nothing was written; `linked` — `CLAUDE.md` and `AGENTS.md` are one file, so no pointer is needed; `refused` — not written, and `reason` says why. On a dry run, what a write would do.",
      ),
    reason: z
      .string()
      .nullable()
      .describe("Why the file was refused, in one line that never quotes it. `null` unless `state` is `refused`."),
  })
  .describe("What Pithy did to one agent instructions file.");
export type InstructionsFile = z.infer<typeof InstructionsFile>;

/** The block's prose, one line per paragraph and per item — never hard-wrapped. */
const PROSE = [
  "## Pithy",
  "",
  "This project is built on Pithy. Drive it through the `pithy` CLI.",
  "",
  "- Run `pithy schema --json` for every command, flag and `--json` payload the installed version takes, or `pithy schema <command> --json` for one.",
  `- Set \`${JSON_MODE_ENV}=compact\` so every \`--json\` document is one line, at a terminal or not.`,
  `- Set \`${NONINTERACTIVE_ENV}=1\` so no prompt waits on you. A question with no default fails \`input/required\` and names the flag that answers it.`,
  "- Run a command that changes anything with `--dry-run` first, where it takes one, and show a person the plan.",
  "- `pithy remove` and every typed confirmation phrase belong to a person. Exit 5 means stop and ask. Never try variations.",
  "",
  "Each failure exits by kind, so test for non-zero, not `1`. Under `--json` a failure is one `error` line on stderr, carrying `exit`, `retryable`, and `fix` when a command fixes it.",
  "",
  "The exception is a report. `pithy doctor`, `pithy deploy`, `pithy upgrade` and `pithy ui sync` write their report on stdout and no `error` line when they find something: read the report. Each exits 1, except that a `pithy deploy` whose failed Worker row carries `exit` exits with the first such row's `exit`.",
  "",
  "| Exit | Meaning | Do |",
  "|---|---|---|",
];

/** The block, markers included, with no trailing line ending. `eol` follows the document it goes into. */
export function renderAgentsBlock(eol: "\n" | "\r\n" = "\n"): string {
  const table = exitCodes().map((row) => `| ${row.exit} | ${row.meaning} | ${row.agentShould} |`);
  return [BLOCK_OPEN, ...PROSE, ...table, BLOCK_CLOSE].join(eol);
}

/** The line ending a document already uses. A file with any CRLF is a CRLF file. */
function eolOf(document: string): "\n" | "\r\n" {
  return document.includes("\r\n") ? "\r\n" : "\n";
}

/** What goes between a document's last byte and an appended paragraph, so exactly one blank line sits there. */
function separatorFor(document: string, eol: string): string {
  if (document === "" || document.endsWith(`${eol}${eol}`)) return "";
  if (document.endsWith(eol)) return eol;
  return `${eol}${eol}`;
}

/** `addition`, appended after a blank line, ending in a line ending. A missing document is the addition alone. */
function appended(document: string | null, render: (eol: "\n" | "\r\n") => string): string {
  if (document === null) return `${render("\n")}\n`;
  const eol = eolOf(document);
  return `${document}${separatorFor(document, eol)}${render(eol)}${eol}`;
}

/** One line of a document: where it starts, where its text ends (before the line ending), and the text. */
interface Line {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Every line, with its offsets into the document, so a splice can keep every byte outside it. */
function linesOf(document: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= document.length) {
    const newline = document.indexOf("\n", start);
    const stop = newline === -1 ? document.length : newline;
    const end = stop > start && document[stop - 1] === "\r" ? stop - 1 : stop;
    lines.push({ start, end, text: document.slice(start, end) });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

/** A refusal of `AGENTS.md`'s markers, in one line that names the file and never quotes it. */
function refusedMarkers(why: string): MergeResult {
  return {
    state: "refused",
    reason: `${AGENTS_FILE} has ${why}. Fix the markers, or delete them, and run pithy upgrade.`,
  };
}

/**
 * Put the current block into `document`: appended when it has none, replaced in place when it has one,
 * refused when its markers say anything else. `null` is a file that is not there.
 */
export function mergeAgentsBlock(document: string | null): MergeResult {
  if (document === null) return { state: "merged", outcome: "added", document: appended(null, renderAgentsBlock) };
  const lines = linesOf(document);
  const opens = lines.filter((line) => line.text.trim().startsWith(OPEN_PREFIX));
  const closes = lines.filter((line) => line.text.trim().startsWith(CLOSE_PREFIX));
  if (opens.length === 0 && closes.length === 0) {
    return { state: "merged", outcome: "added", document: appended(document, renderAgentsBlock) };
  }
  if (opens.length > 1 || closes.length > 1) return refusedMarkers("more than one Pithy block");
  const [open] = opens;
  const [close] = closes;
  if (open === undefined) return refusedMarkers("a pithy:end marker without its pithy:begin");
  if (close === undefined) return refusedMarkers("a pithy:begin marker without its pithy:end");
  if (close.start < open.start) return refusedMarkers("a pithy:end marker before its pithy:begin");

  const next = `${document.slice(0, open.start)}${renderAgentsBlock(eolOf(document))}${document.slice(close.end)}`;
  return next === document
    ? { state: "merged", outcome: "unchanged", document }
    : { state: "merged", outcome: "updated", document: next };
}

/**
 * Put the pointer into `document`: unchanged when any line already imports `AGENTS.md`, appended
 * otherwise. Never `updated` — the pointer is one line, and a file that words its own import differently
 * has said the same thing.
 */
export function mergeClaudePointer(document: string | null): MergeResult {
  if (document !== null && linesOf(document).some((line) => line.text.includes(AGENTS_IMPORT))) {
    return { state: "merged", outcome: "unchanged", document };
  }
  return { state: "merged", outcome: "added", document: appended(document, () => CLAUDE_POINTER) };
}

/** The errno a failed filesystem call carried, or `unknown`. */
function errnoOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown error";
}

/** Whether `path` is a symlink. A path that is not there, or will not stat, is not one. */
async function isSymlink(path: string): Promise<boolean> {
  const entry = await lstatAsProject(path).catch(() => null);
  return entry?.isSymbolicLink() ?? false;
}

/**
 * Read `name` under `projectDir`, merge, and write unless nothing changed or this is a dry run.
 *
 * A symlink is refused before anything is read. `git clone` creates the link as the person cloning, so
 * `writeFileAtomic`'s rule — follow a link the writer owns — would read it as theirs and follow it out of
 * the project; `pithy docs connect` refuses its project files on the same reasoning (`mcp/connect.ts`).
 */
async function sync(
  projectDir: string,
  name: string,
  merge: (document: string | null) => MergeResult,
  dryRun: boolean,
): Promise<InstructionsFile> {
  const refused = (reason: string): InstructionsFile => ({ path: name, state: "refused", reason });
  const path = join(projectDir, name);
  if (await isSymlink(path)) return refused(`${name} is a symlink.`);

  const read = await readFileOutcome(path);
  if (read.state === "unreadable") return refused(`Could not read ${name} (${read.code ?? "unknown error"}).`);
  const merged = merge(read.state === "read" ? read.text : null);
  if (merged.state === "refused") return refused(merged.reason);

  // Never rewrite identical bytes: a no-op write still moves the mtime, and an editor watching the file
  // reloads it for nothing.
  if (merged.outcome !== "unchanged" && !dryRun) {
    try {
      // 0o644 for a file created here: instructions, not credentials. `writeFileAtomic` keeps a mode the
      // project already chose.
      await writeFileAtomic(path, merged.document, { mode: 0o644 });
    } catch (error) {
      return refused(`Could not write ${name} (${errnoOf(error)}).`);
    }
  }
  return { path: name, state: merged.outcome, reason: null };
}

/**
 * Write, refresh, or (on a dry run) report the Pithy block in the project's `AGENTS.md`. `pithy init` and
 * `pithy upgrade` both call this, so the two cannot write different blocks.
 */
export async function syncAgentsBlock(projectDir: string, options: { dryRun: boolean }): Promise<InstructionsFile> {
  return sync(projectDir, AGENTS_FILE, mergeAgentsBlock, options.dryRun);
}

/** `path`'s real path, or `null` when it does not resolve. */
async function realOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/**
 * Point `CLAUDE.md` at `AGENTS.md`: create it holding the one line, or append the line to it.
 *
 * **`linked` before anything else.** `ln -s AGENTS.md CLAUDE.md`, and the reverse, are how many projects
 * share one file between harnesses already. Both names are then one file, which is already read as both,
 * and a pointer written there would be a file importing itself.
 */
export async function syncClaudePointer(projectDir: string): Promise<InstructionsFile> {
  const [claude, agents] = await Promise.all([
    realOrNull(join(projectDir, CLAUDE_FILE)),
    realOrNull(join(projectDir, AGENTS_FILE)),
  ]);
  if (claude !== null && claude === agents) return { path: CLAUDE_FILE, state: "linked", reason: null };
  return sync(projectDir, CLAUDE_FILE, mergeClaudePointer, false);
}

/**
 * The line a person reads about `AGENTS.md`, or `null` when nothing changed. Silence on `unchanged` is
 * deliberate: a re-run that found the block current has nothing to say, and `--json` still says it.
 */
export function agentsLine(file: InstructionsFile, dryRun: boolean): string | null {
  if (file.state === "refused") return `${file.reason ?? `${file.path} was refused.`} Not written.`;
  if (file.state === "added")
    return dryRun ? `${AGENTS_FILE}: would add the Pithy block.` : `${AGENTS_FILE}: Pithy block added.`;
  if (file.state === "updated") {
    return dryRun ? `${AGENTS_FILE}: would refresh the Pithy block.` : `${AGENTS_FILE}: Pithy block refreshed.`;
  }
  return null;
}

/** The line a person reads about `CLAUDE.md`, or `null` when it already pointed at `AGENTS.md`. */
export function claudeLine(file: InstructionsFile): string | null {
  if (file.state === "refused") return `${file.reason ?? `${file.path} was refused.`} Not written.`;
  if (file.state === "added") return `${CLAUDE_FILE}: points at ${AGENTS_FILE}.`;
  return null;
}
