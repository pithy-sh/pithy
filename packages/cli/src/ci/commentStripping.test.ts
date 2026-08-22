// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **No gate in this repository writes its own comment stripper.**
 *
 * A tripwire that reads TypeScript source has to walk past prose, so it strips comments first. Written
 * as a `replace` over a comment pattern that is silently wrong twice, because a pattern has no notion of
 * a string and a string is where a comment is forged: the `//` in `"https://api.cloudflare.com"` opens a
 * line comment and takes the rest of that line with it, and the `/*` in an unbalanced glob opens a block
 * that runs to the next close anywhere later in the file. Both were measured on planted source, and both
 * are silent — the scan reports nothing and passes, and the file it exempted looks scanned (#437, #439).
 *
 * Twenty-eight call sites had written it. `blankComments` in `@pithy-sh/core/src/text/comments` is the
 * one they now share; its docblock says why it lives there rather than beside the walk in this directory.
 *
 * **This is a gate rather than a note in a changeset**, for the reason `./sourceFiles.test.ts` states
 * about the walk: #185 claimed there was one traversal and there were six, and nobody found out until a
 * tripwire flaked. Written back, the same claim is checkable — so the next `replace` over a comment
 * pattern fails the build with its file named, and an exception has to be argued rather than typed.
 */

/** The repo root, four levels up from `packages/cli/src/ci`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * The escaped shapes only a comment stripper writes, built from strings rather than written as regex
 * literals and matched as substrings of the code.
 *
 * Each carries the part that makes it a stripper rather than a coincidence. A regex holding a URL
 * (`https?:\/\/…`) has the slashes and neither run: the line shapes carry the run to the end of the
 * line, and the block shape is only counted when its closer follows within {@link BLOCK_SPAN}
 * characters — which is a match over the comment's body, not the `\/\*\*` that
 * `packages/vite/src/clientEnvDeclaration.test.ts` uses to *count* docblocks it must not lose.
 */
const LINE_SHAPES = [String.raw`\/\/[^\n]`, String.raw`\/\/.*`];

/** The escaped block opener, and the closer that turns it into a strip. */
const BLOCK_OPENER = String.raw`\/\*`;
const BLOCK_CLOSER = String.raw`\*\/`;

/** How far past an opener the closer may sit and still be the same pattern. Every real one is inside 12. */
const BLOCK_SPAN = 40;

/**
 * The files allowed to strip comments themselves, and why. Both halves are checked, so a reason that has
 * stopped being true fails as loudly as a new stripper.
 */
const OWN_STRIPPER: Record<string, string> = {
  "packages/cli/src/ui/screenStyles.ts":
    "CSS, not TypeScript. A stylesheet has no line comments and no string a block opener can hide in, so the pattern is exact rather than approximate — see the reader's own docblock.",
  "packages/ui-react/src/humanityCheckFit.test.ts":
    "CSS, for the same reason: it reads `pithy-screens.css`, where the block form is the whole comment grammar.",
  "packages/cli/src/ci/commentStripping.test.ts":
    "This gate. It has to name the shapes it forbids, and a rule that cannot be written down cannot be enforced.",
};

/** Repo-relative and POSIX-separated, so a declaration reads the same on every machine. */
function named(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

/** Whether a file's code — never its prose — writes one of the shapes. */
function stripsComments(text: string): boolean {
  const code = blankComments(text);
  if (LINE_SHAPES.some((shape) => code.includes(shape))) return true;
  for (let at = code.indexOf(BLOCK_OPENER); at >= 0; at = code.indexOf(BLOCK_OPENER, at + 1)) {
    if (code.slice(at + BLOCK_OPENER.length, at + BLOCK_SPAN).includes(BLOCK_CLOSER)) return true;
  }
  return false;
}

describe("one comment stripper, and the files that may not use it are written down", () => {
  const files = sourcePaths(REPO_ROOT, {
    keep: (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts"),
  });

  test("scans the whole repository, so the rule below is not vacuous", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((path) => named(path) === "packages/core/src/text/comments.ts")).toBe(true);
  });

  test("the detector sees a stripper, and does not see a URL", () => {
    // Anti-vacuous, both ways. A detector that matched nothing would pass the rule forever; one that
    // matched every regex holding a slash would put half the repository on the list above.
    expect(stripsComments(String.raw`const code = text.replace(/\/\*[\s\S]*?\*\//g, "");`)).toBe(true);
    expect(stripsComments(String.raw`const code = text.replace(/\/\/[^\n]*/g, "");`)).toBe(true);
    expect(stripsComments(String.raw`const hosts = text.match(/https?:\/\/[^"']+/g);`)).toBe(false);
    // And counting docblocks is not stripping them: the opener alone, with no closer behind it.
    expect(stripsComments(String.raw`const comments = inlined.match(/\/\*\*/g)?.length ?? 0;`)).toBe(false);
    // And prose quoting the shape is prose. This file's own docblock does exactly that.
    expect(stripsComments(String.raw`// strips with /\/\*[\s\S]*?\*\//g`)).toBe(false);
  });

  test("every file that strips comments itself is declared, and every declaration still strips", () => {
    const found = new Set<string>();
    for (const path of files) {
      const text = readSource(path);
      if (text !== null && stripsComments(text)) found.add(named(path));
    }
    expect({
      undeclared: [...found].filter((path) => !(path in OWN_STRIPPER)).sort(),
      stale: Object.keys(OWN_STRIPPER)
        .filter((path) => !found.has(path))
        .sort(),
    }).toEqual({ undeclared: [], stale: [] });
  });
});
