// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **A JSONC document Pithy re-emits goes through the one printer, or it is not Pithy's to write.**
 *
 * #249 fixed the shape of that output: `comment-json`'s `stringify` puts every array element on its own
 * line, the Biome the kit scaffolds collapses a short one, so a config the CLI wrote failed the
 * pre-commit hook the CLI installed — and a two-line edit arrived as a whole-file reformat nobody could
 * review. `project/jsonc.ts` is the fix and `ui/formatting.test.ts` proves it for `pithy ui`.
 *
 * This is the *class*. Every producer of that defect has the same shape — parse a JSONC file, mutate the
 * tree, `stringify` it, write the bytes — and there have been four of them in three directories. A gate
 * naming files would have missed `provision/wranglerEnv.ts`, which did not exist when #249 landed and
 * reintroduced the bug the same week. So the rule is about the *call*, not the directory: outside the
 * printer, nothing turns a `comment-json` tree back into bytes.
 *
 * `parse` is untouched — reading a JSONC document is what every one of these modules is for.
 */

const CLI_SRC = join(import.meta.dirname, "..");

/** The one module allowed to serialize, plus the exceptions that are still open, each with its reason. */
const ALLOWED = new Map<string, string>([
  ["project/jsonc.ts", "the printer itself — this is where `stringify` is supposed to be"],
  [
    "devSecrets/file.ts",
    // Listed rather than excused, and asserted exactly, so closing it fails this test until the list
    // shrinks with it. `.dev.secrets.jsonc` is scaffolded, Biome formats it since #249 stopped exempting
    // Pithy's own files, and this writer still emits `stringify`'s shape. It is `0o600` and hand-edited,
    // so the diff cost is lower than `wrangler.jsonc`'s — which is why it is a backlog item and not a
    // reason to weaken the rule.
    "still writes `stringify`'s shape for .dev.secrets.jsonc — open, tracked, and not a licence",
  ],
]);

/**
 * Does this source turn a `comment-json` tree into bytes on disk?
 *
 * Both halves are required, and the second half is why. `project/appWorkflows.ts` imports `stringify`
 * to compare two trees — `stringify(stanza) !== stanzaBefore` is how it knows whether it changed
 * anything — and then writes through `writeWranglerConfig`. Serializing for a comparison is not
 * emitting a file, and a gate that could not tell the two apart would be a gate somebody turns off.
 */
function serializesToDisk(source: string): boolean {
  const imports = /import\s*\{[^}]*\bstringify\b[^}]*\}\s*from\s*"comment-json"/.test(source);
  return imports && /\bwriteFileAtomic\(|\bwriteFile\(/.test(source);
}

describe("a JSONC document Pithy re-emits goes through the one printer", () => {
  // The shared walker (#185), not a hand-rolled one. Its default `keep` is already this rule — a
  // shipped `.ts`, neither a test nor a declaration — and it hands back the text, so nothing here
  // reads a file twice. A walk written out again here would be the defect this repository has paid
  // for five times, in the gate built to stop the sixth.
  const files = sourceFiles(CLI_SRC);

  it("finds the CLI's sources", () => {
    // Non-vacuity: a walk that matched nothing would make the rule below pass forever.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path.endsWith(join("project", "jsonc.ts")))).toBe(true);
  });

  it("only the printer, and the exceptions this file names, serialize a comment-json tree", () => {
    const serializers = files
      .filter((file) => serializesToDisk(file.text))
      .map((file) => relative(CLI_SRC, file.path).split("\\").join("/"))
      .sort();
    expect(serializers).toEqual([...ALLOWED.keys()].sort());
  });
});
