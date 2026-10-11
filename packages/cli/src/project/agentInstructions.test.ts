// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { exitCodes } from "../contract/describe";
import { EXIT } from "../terminal/exitClass";
import { NONINTERACTIVE_ENV } from "../terminal/inputMode";
import { JSON_MODE_ENV } from "../terminal/jsonMode";
import { KIT_ROOT } from "../test-utils/kitRoot";
import {
  AGENTS_FILE,
  agentsLine,
  BLOCK_CLOSE,
  BLOCK_OPEN,
  CLAUDE_FILE,
  CLAUDE_POINTER,
  claudeLine,
  InstructionsFile,
  mergeAgentsBlock,
  mergeClaudePointer,
  renderAgentsBlock,
  syncAgentsBlock,
  syncClaudePointer,
} from "./agentInstructions";
import { deployFailureExit } from "./deploy";

/**
 * **The Pithy block in `AGENTS.md`, and the one line in `CLAUDE.md` that points at it (#697).**
 *
 * `pithy init` writes both and `pithy upgrade` rewrites the block. Every claim below is about a file
 * somebody else may already have written: the block is the only part of `AGENTS.md` Pithy owns, so text
 * outside it is asserted byte for byte, before and after, on every path that writes. A document with
 * markers Pithy cannot read unambiguously is refused rather than guessed at, and a refusal never quotes
 * the file. A merge that changes nothing writes nothing, so a re-run does not touch the mtime.
 */

/** A string a refusal must never repeat — anything in the file is somebody else's. */
const NEVER_ECHOED = "sk-live-must-never-be-echoed";

/** The block as `upgrade` writes it today, with the newline a merge puts after it. */
const BLOCK = `${renderAgentsBlock()}\n`;

/** The merged document, or the test fails naming the refusal. */
function merged(result: ReturnType<typeof mergeAgentsBlock>): { outcome: string; document: string } {
  if (result.state === "refused") throw new Error(`Refused: ${result.reason}`);
  return result;
}

describe("renderAgentsBlock", () => {
  test("opens and closes on the markers, and every line between them is Pithy's", () => {
    const lines = renderAgentsBlock().split("\n");
    expect(lines[0]).toBe(BLOCK_OPEN);
    expect(lines.at(-1)).toBe(BLOCK_CLOSE);
    expect(lines.filter((line) => line === BLOCK_OPEN || line === BLOCK_CLOSE)).toHaveLength(2);
  });

  test("says what an agent needs: the schema, both variables, dry runs, and what belongs to a person", () => {
    const block = renderAgentsBlock();
    expect(block).toContain("`pithy schema --json`");
    expect(block).toContain(`\`${JSON_MODE_ENV}=compact\``);
    expect(block).toContain(`\`${NONINTERACTIVE_ENV}=1\``);
    expect(block).toContain("`--dry-run`");
    expect(block).toContain("`pithy remove`");
    expect(block).toContain("confirmation phrase");
    expect(block).toContain("non-zero, not `1`");
  });

  /**
   * **The one-error-line rule has an exception, and the block has to carry it (#697).** A command that reports
   * — `doctor`, `deploy`, `upgrade`, `ui sync` — writes its report and no error line when it finds something.
   * An agent told only "a failure is one error line" waits on stderr for a line that never comes.
   * `docs/CLI.md` §3.8 names the commands; the block names every one it does.
   */
  test("names the report commands, which write their report and no error line, as CLI.md §3.8 does", async () => {
    const line = (await cliMd()).split("\n").find((candidate) => candidate.startsWith("- **1, failed.**")) ?? "";
    const clause = line.slice(line.indexOf("A run that reports"), line.indexOf(" exits 1 too"));
    const named = [...clause.matchAll(/`([a-z ]+?)`/g)].map((match) => match[1]);
    expect(named).toEqual(["doctor", "deploy", "upgrade", "ui sync"]);
    const exception = reportLine();
    expect(exception, "the block states the report exception").toBeDefined();
    for (const command of named) expect(exception).toContain(`\`pithy ${command}\``);
  });

  /**
   * **And the exit it states is the exit the code returns (#697).** A report exits 1, except a deploy whose
   * failed Worker row carries `exit` — Cloudflare refusing the credentials after an earlier Worker already had
   * a row — which exits with the first such row's `exit`, 3. The block said "exit 1" of all four, so an agent
   * reading a 3 off a deploy was told it was a different kind of failure from the one it got. The rule is one
   * clause, written the same in the block, in `docs/CLI.md` §3.8 and in `docs/commands/deploy.md`, and
   * `deployFailureExit` is held to it here.
   */
  test("states the exit a report ends with, as deployFailureExit computes it, in the block and both pages", async () => {
    const RULE = "whose failed Worker row carries `exit` exits with the first such row's `exit`";
    expect(reportLine()).toContain("Each exits 1");
    expect(reportLine()).toContain(`\`pithy deploy\` ${RULE}`);
    const failedLine = (await cliMd()).split("\n").find((candidate) => candidate.startsWith("- **1, failed.**"));
    expect(failedLine).toContain(`\`deploy\` ${RULE}`);
    const deployPage = await readFile(join(KIT_ROOT, "..", "..", "docs", "commands", "deploy.md"), "utf8");
    expect(deployPage.split(RULE).length - 1, "deploy.md states it where it states the exit").toBeGreaterThanOrEqual(2);

    const row = (exit?: number) => ({ name: "api", ok: false, error: "boom", ...(exit === undefined ? {} : { exit }) });
    expect(deployFailureExit([row(), row()])).toBe(EXIT.failed);
    expect(deployFailureExit([row(), row(EXIT.precondition), row(EXIT.upstream)])).toBe(EXIT.precondition);
    expect(deployFailureExit([{ name: "web", ok: true }, row(EXIT.upstream)])).toBe(EXIT.upstream);
  });

  test("its exit-code table is the one `pithy schema` publishes, row for row, so the two cannot drift", () => {
    const rows = renderAgentsBlock()
      .split("\n")
      .filter((line) => /^\| \d+ \|/.test(line));
    expect(rows).toEqual(exitCodes().map((row) => `| ${row.exit} | ${row.meaning} | ${row.agentShould} |`));
    expect(rows.length).toBeGreaterThan(5);
  });

  test("no line is hard-wrapped: every prose line ends a sentence or is markup", () => {
    for (const line of renderAgentsBlock().split("\n")) {
      if (line === "" || line.startsWith("|") || line.startsWith("<!--") || line.startsWith("#")) continue;
      expect(line, line).toMatch(/[.:]$/);
    }
  });

  test("takes the document's line ending", () => {
    const crlf = renderAgentsBlock("\r\n");
    expect(crlf.split("\r\n")).toEqual(renderAgentsBlock().split("\n"));
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("mergeAgentsBlock", () => {
  test("with no file at all, the document is the block", () => {
    expect(merged(mergeAgentsBlock(null))).toEqual({ state: "merged", outcome: "added", document: BLOCK });
  });

  test("an empty file is the block too", () => {
    expect(merged(mergeAgentsBlock("")).document).toBe(BLOCK);
  });

  test.each([
    ["ending in a newline", "# Agents\n\nUse tabs.\n", "\n"],
    ["ending in a blank line", "# Agents\n\nUse tabs.\n\n", ""],
    ["with no final newline", "# Agents\n\nUse tabs.", "\n\n"],
  ])("a file without the block, %s, keeps every byte and gains it after a blank line", (_, original, separator) => {
    const result = merged(mergeAgentsBlock(original));
    expect(result.outcome).toBe("added");
    expect(result.document.startsWith(original)).toBe(true);
    expect(result.document).toBe(`${original}${separator}${BLOCK}`);
  });

  test("a stale block is refreshed, and the text either side of it is byte-identical", () => {
    const before = "# Agents\n\nUse tabs.\n\n";
    const after = "\n## Ours\n\nNever push to main.\n";
    const stale = `${BLOCK_OPEN}\nRun pithy catalog.\n${BLOCK_CLOSE}`;
    const result = merged(mergeAgentsBlock(`${before}${stale}${after}`));
    expect(result.outcome).toBe("updated");
    expect(result.document).toBe(`${before}${renderAgentsBlock()}${after}`);
  });

  test("an older open marker is still ours — it is matched by its prefix, so its wording can change", () => {
    const result = merged(mergeAgentsBlock(`<!-- pithy:begin (older words) -->\nold\n${BLOCK_CLOSE}\n`));
    expect(result.outcome).toBe("updated");
    expect(result.document).toBe(BLOCK);
  });

  test("a current block is unchanged, and the document comes back as the same string", () => {
    const document = `# Agents\n\n${BLOCK}\nMore of ours.\n`;
    expect(merged(mergeAgentsBlock(document))).toEqual({ state: "merged", outcome: "unchanged", document });
  });

  test("merged twice is unchanged the second time", () => {
    const once = merged(mergeAgentsBlock("# Agents\n")).document;
    expect(merged(mergeAgentsBlock(once))).toEqual({ state: "merged", outcome: "unchanged", document: once });
  });

  test("a CRLF document gets a CRLF block, and keeps its own bytes", () => {
    const original = "# Agents\r\n\r\nUse tabs.\r\n";
    const result = merged(mergeAgentsBlock(original));
    expect(result.document).toBe(`${original}\r\n${renderAgentsBlock("\r\n")}\r\n`);
    expect(merged(mergeAgentsBlock(result.document)).outcome).toBe("unchanged");
  });

  test.each([
    ["an open marker without its close", `${BLOCK_OPEN}\n${NEVER_ECHOED}\n`, "without its pithy:end"],
    ["a close marker without its open", `${NEVER_ECHOED}\n${BLOCK_CLOSE}\n`, "without its pithy:begin"],
    ["the close before the open", `${BLOCK_CLOSE}\n${NEVER_ECHOED}\n${BLOCK_OPEN}\n`, "before its pithy:begin"],
    ["two blocks", `${BLOCK}${NEVER_ECHOED}\n${BLOCK}`, "more than one"],
  ])("%s is refused, never guessed at, and the reason quotes nothing", (_, document, says) => {
    const result = mergeAgentsBlock(document);
    expect(result.state).toBe("refused");
    if (result.state !== "refused") return;
    expect(result.reason).toContain(says);
    expect(result.reason).toContain(AGENTS_FILE);
    expect(result.reason).not.toContain(NEVER_ECHOED);
    expect(result.reason).not.toContain("\n");
  });
});

describe("mergeClaudePointer", () => {
  test("with no file at all, the document is the pointer", () => {
    expect(mergeClaudePointer(null)).toEqual({ state: "merged", outcome: "added", document: `${CLAUDE_POINTER}\n` });
  });

  test("the pointer imports AGENTS.md, so Claude Code reads the file rather than only its name", () => {
    expect(CLAUDE_POINTER).toContain("@AGENTS.md");
  });

  test("a file without it keeps every byte and gains one line after a blank line", () => {
    const original = "# Rules\n\nNo emoji.\n";
    const result = mergeClaudePointer(original);
    expect(result).toEqual({ state: "merged", outcome: "added", document: `${original}\n${CLAUDE_POINTER}\n` });
  });

  test("a file that already imports AGENTS.md, however it says so, is unchanged", () => {
    const document = "# Rules\n\nSee @AGENTS.md.\n";
    expect(mergeClaudePointer(document)).toEqual({ state: "merged", outcome: "unchanged", document });
  });

  test("a CRLF file gets a CRLF line", () => {
    const original = "# Rules\r\n";
    expect(mergeClaudePointer(original)).toEqual({
      state: "merged",
      outcome: "added",
      document: `${original}\r\n${CLAUDE_POINTER}\r\n`,
    });
  });
});

describe("on disk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-agents-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const agents = () => join(dir, AGENTS_FILE);
  const claude = () => join(dir, CLAUDE_FILE);

  describe("syncAgentsBlock", () => {
    test("creates AGENTS.md holding the block", async () => {
      const result = await syncAgentsBlock(dir, { dryRun: false });
      expect(result).toEqual({ path: AGENTS_FILE, state: "added", reason: null });
      expect(await readFile(agents(), "utf8")).toBe(BLOCK);
      expect(InstructionsFile.parse(result)).toEqual(result);
    });

    test("refreshes the block in place, leaving every byte outside it as it was", async () => {
      const before = "# Our agents\n\nAlways run the tests.\n\n";
      const after = "\nAnd never force-push.\n";
      await writeFile(agents(), `${before}${BLOCK_OPEN}\nstale\n${BLOCK_CLOSE}${after}`);
      expect((await syncAgentsBlock(dir, { dryRun: false })).state).toBe("updated");
      expect(await readFile(agents(), "utf8")).toBe(`${before}${renderAgentsBlock()}${after}`);
    });

    test("a current block writes nothing, so the mtime holds", async () => {
      await writeFile(agents(), BLOCK);
      const past = new Date("2020-01-01T00:00:00Z");
      await utimes(agents(), past, past);
      expect((await syncAgentsBlock(dir, { dryRun: false })).state).toBe("unchanged");
      expect((await stat(agents())).mtime.getTime()).toBe(past.getTime());
    });

    test("a dry run reports what it would do and writes nothing", async () => {
      expect((await syncAgentsBlock(dir, { dryRun: true })).state).toBe("added");
      await expect(lstat(agents())).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(agents(), "# Ours\n");
      expect((await syncAgentsBlock(dir, { dryRun: true })).state).toBe("added");
      expect(await readFile(agents(), "utf8")).toBe("# Ours\n");
    });

    test("malformed markers are refused and the file is left alone", async () => {
      const document = `${BLOCK_OPEN}\n${NEVER_ECHOED}\n`;
      await writeFile(agents(), document);
      const result = await syncAgentsBlock(dir, { dryRun: false });
      expect(result.state).toBe("refused");
      expect(result.reason).not.toContain(NEVER_ECHOED);
      expect(await readFile(agents(), "utf8")).toBe(document);
    });

    test("a symlinked AGENTS.md is refused — a cloned repo can ship the link, and the write would follow it", async () => {
      const elsewhere = join(dir, "elsewhere.md");
      await writeFile(elsewhere, "not yours\n");
      await symlink(elsewhere, agents());
      expect(await syncAgentsBlock(dir, { dryRun: false })).toEqual({
        path: AGENTS_FILE,
        state: "refused",
        reason: "AGENTS.md is a symlink.",
      });
      expect(await readFile(elsewhere, "utf8")).toBe("not yours\n");
    });

    test("an AGENTS.md that will not open is refused by its errno, and nothing is thrown", async () => {
      await mkdir(agents());
      const result = await syncAgentsBlock(dir, { dryRun: false });
      expect(result.state).toBe("refused");
      expect(result.reason).toBe("Could not read AGENTS.md (EISDIR).");
    });

    test("a directory that is not there is refused rather than thrown", async () => {
      const result = await syncAgentsBlock(join(dir, "missing"), { dryRun: false });
      expect(result.state).toBe("refused");
      expect(result.reason).toContain(AGENTS_FILE);
    });
  });

  describe("syncClaudePointer", () => {
    test("creates CLAUDE.md holding only the pointer when there is none", async () => {
      expect(await syncClaudePointer(dir)).toEqual({ path: CLAUDE_FILE, state: "added", reason: null });
      expect(await readFile(claude(), "utf8")).toBe(`${CLAUDE_POINTER}\n`);
    });

    test("appends the pointer to a CLAUDE.md that lacks it, and every byte before it stays", async () => {
      await writeFile(claude(), "# Rules\n\nNo emoji.\n");
      expect((await syncClaudePointer(dir)).state).toBe("added");
      expect(await readFile(claude(), "utf8")).toBe(`# Rules\n\nNo emoji.\n\n${CLAUDE_POINTER}\n`);
    });

    test("a CLAUDE.md that already imports AGENTS.md is unchanged and not written", async () => {
      await writeFile(claude(), "See @AGENTS.md\n");
      const past = new Date("2020-01-01T00:00:00Z");
      await utimes(claude(), past, past);
      expect((await syncClaudePointer(dir)).state).toBe("unchanged");
      expect((await stat(claude())).mtime.getTime()).toBe(past.getTime());
    });

    test("CLAUDE.md linked to AGENTS.md is the same file already — nothing is written into either", async () => {
      await writeFile(agents(), BLOCK);
      await symlink(AGENTS_FILE, claude());
      expect(await syncClaudePointer(dir)).toEqual({ path: CLAUDE_FILE, state: "linked", reason: null });
      expect(await readFile(agents(), "utf8")).toBe(BLOCK);
    });

    test("AGENTS.md linked to CLAUDE.md is the same file too — a pointer there would import itself", async () => {
      await writeFile(claude(), "# Rules\n");
      await symlink(CLAUDE_FILE, agents());
      expect((await syncClaudePointer(dir)).state).toBe("linked");
      expect(await readFile(claude(), "utf8")).toBe("# Rules\n");
    });

    test("CLAUDE.md linked anywhere else is refused", async () => {
      const elsewhere = join(dir, "elsewhere.md");
      await writeFile(elsewhere, "not yours\n");
      await symlink(elsewhere, claude());
      expect(await syncClaudePointer(dir)).toEqual({
        path: CLAUDE_FILE,
        state: "refused",
        reason: "CLAUDE.md is a symlink.",
      });
      expect(await readFile(elsewhere, "utf8")).toBe("not yours\n");
    });
  });
});

describe("the lines a person reads", () => {
  const file = (state: InstructionsFile["state"], reason: string | null = null): InstructionsFile => ({
    path: AGENTS_FILE,
    state,
    reason,
  });

  test("AGENTS.md says what happened to the block, in either tense, and nothing when nothing changed", () => {
    expect(agentsLine(file("added"), false)).toBe("AGENTS.md: Pithy block added.");
    expect(agentsLine(file("updated"), false)).toBe("AGENTS.md: Pithy block refreshed.");
    expect(agentsLine(file("added"), true)).toBe("AGENTS.md: would add the Pithy block.");
    expect(agentsLine(file("updated"), true)).toBe("AGENTS.md: would refresh the Pithy block.");
    expect(agentsLine(file("unchanged"), false)).toBeNull();
    expect(agentsLine(file("refused", "AGENTS.md is a symlink."), false)).toBe("AGENTS.md is a symlink. Not written.");
  });

  test("CLAUDE.md says it points at AGENTS.md, and nothing when it already did", () => {
    const pointer = (state: InstructionsFile["state"], reason: string | null = null): InstructionsFile => ({
      path: CLAUDE_FILE,
      state,
      reason,
    });
    expect(claudeLine(pointer("added"))).toBe("CLAUDE.md: points at AGENTS.md.");
    expect(claudeLine(pointer("unchanged"))).toBeNull();
    expect(claudeLine(pointer("linked"))).toBeNull();
    expect(claudeLine(pointer("refused", "CLAUDE.md is a symlink."))).toBe("CLAUDE.md is a symlink. Not written.");
  });
});

/** `docs/CLI.md`, which §3.8 of the tests above reads. */
function cliMd(): Promise<string> {
  return readFile(join(KIT_ROOT, "..", "..", "docs", "CLI.md"), "utf8");
}

/** The block's line about the report commands. */
function reportLine(): string | undefined {
  return renderAgentsBlock()
    .split("\n")
    .find((candidate) => candidate.includes("no `error` line"));
}
