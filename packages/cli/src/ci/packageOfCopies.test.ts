// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **The scope-aware package-name rule is written once, in `@pithy-sh/core/src/naming/packageName.ts` (#709).**
 *
 * There were five copies, and two of them took the first two segments whatever they were, which is right for every `@pithy-sh/*` name and wrong for the first unscoped dependency. Migrating them by hand left two more behind in this very directory, and a builder's "a grep finds no remaining copy" was not true. So the claim is a gate, not a sentence.
 *
 * A copy is recognized by the two shapes every one of them took: a leading `@` choosing between two segments and one (`startsWith("@") ? 2 : 1`, or a `scoped ? 2 : 1` after it), and the regex `^(@[^/]+\/[^/]+)` that captures a scope and a name. Comments are blanked first, so a docblock describing the rule is not a copy of it.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The one home the rule has, and this gate, whose fixtures spell out the shapes it hunts. */
const EXEMPT = new Set([
  ["packages", "core", "src", "naming", "packageName.ts"].join(sep),
  ["packages", "cli", "src", "ci", "packageOfCopies.test.ts"].join(sep),
]);

/** Every script the repository writes, shipped or test, TypeScript or JavaScript; never a declaration file. */
function isScript(name: string): boolean {
  return /\.(?:[cm]?[jt]s|tsx)$/.test(name) && !name.endsWith(".d.ts");
}

/** The shapes a hand-written copy takes. */
const COPY_SHAPES: readonly RegExp[] = [
  /startsWith\(\s*["']@["']\s*\)\s*\?\s*2\s*:\s*1\b/,
  // A leading `@` choosing between a joined `scope/name` and the first segment alone, whatever else the
  // condition checks: `first.startsWith("@") && second !== undefined ? `${first}/${second}` : first`.
  // `tooling/browser-scopes` kept this one after the gate landed, because the gate knew only the two above.
  /startsWith\(\s*["']@["']\s*\)[^;?]*\?\s*`\$\{[^}]+\}\/\$\{[^}]+\}`/,
  /\bscoped\s*\?\s*2\s*:\s*1\b/,
  /\^\(?@\[\^\/\]\+\\\/\[\^\/\]\+/,
];

/** Every line of `text` that writes the rule out by hand. */
function copiesIn(text: string): number[] {
  const lines = blankComments(text).split("\n");
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (COPY_SHAPES.some((shape) => shape.test(line))) found.push(index + 1);
  });
  return found;
}

describe("packageOf has one copy", () => {
  test("the detector recognizes every shape a copy has taken, and not a comment about one", () => {
    expect(copiesIn('const width = head.startsWith("@") ? 2 : 1;')).toEqual([1]);
    expect(copiesIn('const scoped = s.startsWith("@");\nparts.slice(0, scoped ? 2 : 1);')).toEqual([2]);
    expect(copiesIn("const scoped = /^(@[^/]+\\/[^/]+)/.exec(specifier);")).toEqual([1]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text that holds a template literal.
    const templated = 'return first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;';
    expect(copiesIn(templated)).toEqual([1]);
    expect(copiesIn('// head.startsWith("@") ? 2 : 1\nconst x = 1;')).toEqual([]);
    expect(copiesIn('cursor += text[cursor] === "\\\\" ? 2 : 1;')).toEqual([]);
  });

  test("no source in the repository writes the rule out instead of importing packageOf", () => {
    const offenders: string[] = [];
    let read = 0;
    // Tests included: the two copies this gate was written for were both in test files.
    for (const path of sourcePaths(REPO_ROOT, { keep: isScript })) {
      const where = relative(REPO_ROOT, path);
      if (EXEMPT.has(where)) continue;
      const text = readSource(path);
      if (text === null) continue;
      read += 1;
      for (const line of copiesIn(text)) offenders.push(`${where}:${line}`);
    }
    // A walk that read nothing would pass vacuously.
    expect(read).toBeGreaterThan(500);
    expect(offenders, "import packageOf from @pithy-sh/core/src/naming/packageName instead").toEqual([]);
  });
});
