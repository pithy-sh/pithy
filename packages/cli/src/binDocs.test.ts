// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * `docs/CLI.md` §4 pastes the CLI's help text, and CLAUDE.md makes that document binding rather than
 * advisory. Nothing checked those blocks, and they did not merely rot — they described a help format the
 * CLI has never produced: a hand-drawn `Usage:` / `Commands:` / `Options:` layout with eight commands, a
 * `Capabilities:` block under `pithy add`, and a `Docs:` footer. Help emits `USAGE` / `ARGUMENTS` /
 * `OPTIONS` / `COMMANDS`, and below the root **citty** owns every byte of it.
 *
 * Since #407 the root screen is Pithy's own — `help/rootUsage.ts`, which groups the commands under
 * headings — and every screen below it is still citty's `renderUsage`. §4.1 pins the first and §4.2 pins
 * the second, by the same mechanism and with the same force: both are captured from the real binary, the
 * way `commands/doctorDocs.test.ts` pins §5.6 to the real renderer. The pin spawns `bin.ts` exactly as
 * `bin.test.ts` does and compares its stdout to the document. When the two disagree, the document is what
 * changes — for §4.2 always, because those bytes are citty's, and for §4.1 unless the renderer is what
 * was meant to change.
 *
 * Determinism, since this compares spawned output byte for byte:
 *
 * - **Color.** citty colors its own output and does not consult `isTTY`; `NO_COLOR=1` is the one switch it
 *   reads (`env.NO_COLOR === "1"`), and it is set on the child. `bin.ts` now sets that itself whenever
 *   Pithy's own rule says color is off, so this is belt to those braces — deliberately kept, because a
 *   transcript pinned byte for byte should not also be the thing that fails when the bin's translation
 *   regresses. That behavior has its own test: `bin.test.ts` "help into a pipe carries no ANSI", which
 *   scrubs `NO_COLOR`, `TEST` and `CI` from the child so the bin has to make the decision on its own.
 * - **Version.** The first line carries `(pithy v0.0.0)` — the workspace's unpublished version, which will
 *   change. The document writes `v<version>`; the expectation substitutes the version read from the CLI's
 *   own `package.json`, so a release bump moves the pin with it instead of breaking it.
 * - **Width.** citty pads its columns to the widest cell (`formatLineColumns`), never to the terminal —
 *   there is no `COLUMNS` or `process.stdout.columns` in its layout — so the alignment is a pure function
 *   of the command tree and identical in every terminal. `rootUsage.ts` copies that rule for the same
 *   reason, and `help/rootUsage.test.ts` asserts it directly: a width-aware renderer would pass on the
 *   author's terminal and flake in CI, which is the one failure a byte-for-byte pin cannot survive.
 * - **Trailing space.** That padding leaves trailing spaces on every short row, and trailing spaces in a
 *   markdown file are whitespace an editor or formatter silently eats. Both sides are right-trimmed per
 *   line, and trailing blank lines (citty appends one, `console.log` another) are dropped. What that
 *   leaves uncovered is exactly the run of spaces after the last visible character of a row — nothing
 *   else. The **leading** padding that right-aligns the command/flag column is `padStart`, and it is
 *   compared in full.
 * - **The notifier.** `PITHY_NO_UPDATE_NOTIFIER=1` on the child, belt to the braces of its `isTTY` gate,
 *   so nothing can reach the network or append to stderr mid-capture.
 */

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "bin.ts");
const REPO_ROOT = join(HERE, "..", "..", "..");
const CLI_MD = readFileSync(join(REPO_ROOT, "docs", "CLI.md"), "utf8");
const { version } = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as { version: string };

/**
 * One subsection, up to the next heading. Scoped, because §4.1 and §4.2 paste one transcript each and a
 * whole-file — or even whole-§4 — scan would pin whichever block happened to come first.
 */
function section(heading: string): string {
  const start = CLI_MD.indexOf(heading);
  if (start === -1) throw new Error(`docs/CLI.md no longer has a "${heading}" section. Repin or restore it.`);
  const rest = CLI_MD.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The fenced blocks of a markdown section, in document order, each without its fences or trailing newline. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => (match[1] ?? "").replace(/\n$/, ""));
}

/** Right-trim every line and drop trailing blank lines — the two axes named in the header comment. */
function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * One section's single transcript, with the `$ …` prompt line the CLI does not emit stripped off and the
 * `<version>` placeholder resolved to the installed version.
 *
 * Every miss throws rather than returning something empty that would compare equal to nothing. A pin that
 * quietly stops matching is worse than no pin at all: the block it guards can then be reworded into help
 * the CLI never prints, and the suite stays green while the document lies. The block count is asserted
 * too, so a second transcript added to a section fails until it is pinned here as well.
 */
function transcript(heading: string, prompt: string): string {
  const blocks = fencedBlocks(section(heading));
  if (blocks.length !== 1) {
    throw new Error(`docs/CLI.md "${heading}" has ${blocks.length} fenced blocks — expected exactly 1.`);
  }
  const lines = (blocks[0] as string).split("\n");
  if (lines[0] !== prompt) {
    throw new Error(`docs/CLI.md "${heading}" transcript opens with "${lines[0]}", expected "${prompt}".`);
  }
  return normalize(lines.slice(1).join("\n")).replaceAll("<version>", version);
}

/** The real binary, spawned the way `bin.test.ts` spawns it, with color and the notifier held still. */
async function help(args: string[]): Promise<string> {
  const { stdout } = await run("bun", [BIN, ...args], {
    env: { ...process.env, NO_COLOR: "1", PITHY_NO_UPDATE_NOTIFIER: "1" },
  });
  return normalize(stdout);
}

describe("docs/CLI.md §4", () => {
  test("§4.1 pastes what `pithy --help` prints", async () => {
    expect(await help(["--help"])).toBe(transcript("### 4.1 Top-level help", "$ pithy --help"));
  });

  test("§4.2 pastes what `pithy add --help` prints", async () => {
    expect(await help(["add", "--help"])).toBe(transcript("### 4.2 Subcommand help", "$ pithy add --help"));
  });

  /**
   * §4.1's prose says `-h, --help` and `-v, --version` work even though citty lists neither in the help it
   * renders. That is a claim about behavior, not layout, so it is checked directly: the version flags
   * print the bare version and nothing else.
   */
  test("`-v` and `--version` print the bare version, as §4.1 says", async () => {
    for (const flag of ["-v", "--version"]) {
      const { stdout } = await run("bun", [BIN, flag], {
        env: { ...process.env, NO_COLOR: "1", PITHY_NO_UPDATE_NOTIFIER: "1" },
      });
      expect(stdout.trim()).toBe(version);
    }
  });
});
