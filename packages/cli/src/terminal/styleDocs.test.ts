// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * `docs/CLI.md` §3.4 pastes the color seam's implementation, and CLAUDE.md makes that document binding
 * rather than advisory. The pasted code had drifted into something worse than stale: it showed
 * `process.env.NO_COLOR || !pc.isColorSupported`, a detection Pithy deliberately rejected — picocolors
 * reads any `CI` env as color-capable, which would bleed ANSI into `--json` output. The reason for the
 * rejection was a comment in the source, so the document taught the bug and the fix lived where no reader
 * of the document would find it.
 *
 * So the block is an extract, not a paraphrase, and it is pinned here the way `binDocs.test.ts` pins the
 * help transcripts: the fenced `ts` block in §3.4 must be the region of `style.ts` from the saffron
 * constants through `saffron` itself, comments included. Edit the seam and this fails until the document
 * carries the new text.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_MD = readFileSync(join(HERE, "..", "..", "..", "..", "docs", "CLI.md"), "utf8");
const STYLE = readFileSync(join(HERE, "style.ts"), "utf8");

/** The pinned region: the saffron constants through the end of `saffron`. */
function pinnedSource(): string {
  const start = STYLE.indexOf("const SAFFRON_TRUECOLOR");
  const end = STYLE.indexOf("\n// The terminal-themed tiers");
  if (start === -1 || end === -1) {
    throw new Error("style.ts no longer has the region docs/CLI.md §3.4 pastes. Repin it or restore it.");
  }
  return STYLE.slice(start, end).trimEnd();
}

/** §3.4's single fenced `ts` block, up to the next heading. */
function pastedSample(): string {
  const start = CLI_MD.indexOf("### 3.4 Color tiers");
  if (start === -1) throw new Error('docs/CLI.md no longer has a "### 3.4 Color tiers" section.');
  const rest = CLI_MD.slice(start);
  const section = rest.slice(0, rest.slice(1).search(/\n#{2,3} /) + 1);
  const blocks = [...section.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");
  if (blocks.length !== 1) {
    throw new Error(`docs/CLI.md §3.4 has ${blocks.length} fenced ts blocks — expected exactly 1.`);
  }
  return (blocks[0] as string).trimEnd();
}

describe("docs/CLI.md §3.4", () => {
  test("pastes the real color seam, not a rejected detection", () => {
    expect(pastedSample()).toBe(pinnedSource());
  });

  /**
   * The named guard against the exact regression: the rejected expression itself. `pc.isColorSupported`
   * still appears in both, in the comment saying why it is not used — the pin above would accept that
   * either way, so the call form is asserted absent on its own.
   */
  test("neither the seam nor the sample calls picocolors' detection", () => {
    expect(STYLE).not.toContain("!pc.isColorSupported");
    expect(pastedSample()).not.toContain("!pc.isColorSupported");
  });
});
