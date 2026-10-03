// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "./sourceFiles";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The one module allowed to know what a hostname looks like. */
const THE_RULE = "packages/core/src/naming/domains.ts";

const posix = (path: string): string => relative(REPO_ROOT, path).split(sep).join("/");

/**
 * Every shipped source file, with its repo-relative path.
 *
 * **Shipped source only — `sourcePaths` defaults to `isShippedSource`, which excludes `*.test.ts`.** That
 * is deliberate and the claim below depends on it: a test naming `HOSTNAME_PATTERN` to assert something
 * about it is not a second producer of the rule, and sweeping tests in would make *the pattern is named in
 * exactly one module* fail on this file and on `core/src/naming/domains.test.ts`, which both mention it by
 * name. What this cannot catch is a test that writes the label shape out by hand; nothing stops that but
 * review.
 */
function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const root of ["packages", "scripts"]) {
    for (const path of sourcePaths(resolve(REPO_ROOT, root))) {
      const text = readSource(path);
      if (text !== null) out.push({ path: posix(path), text });
    }
  }
  return out;
}

const SOURCES = sources();

/**
 * **One rule for "is this a host", stated as the invariant rather than as a list of banned calls.**
 *
 * `pithy-sh/pithy#665`. `isPublicHostname` says it is the one test an origin read from a stamp and an
 * origin typed on a command line both pass, "so the two cannot accept different things". A configured
 * custom domain was a third caller and did not go through it — `WorkerDomain` handed the raw pattern to
 * `.regex()`, so `pithy.config.ts` accepted a punycode A-label and a 267-character name that `pithy seed
 * --host` refused for the same string.
 *
 * Banning `.regex(HOSTNAME_PATTERN` by text would have missed the next spelling: a copy of the pattern, a
 * hand-rolled label check, an `indexOf(".")`. So this asserts the shape itself appears in one module.
 */
describe("one producer of what a hostname is", () => {
  test("the sweep is reading this repository, not an empty tree", () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some(({ path }) => path === THE_RULE)).toBe(true);
  });

  test("**the hostname pattern is named in exactly one module**", () => {
    const named = SOURCES.filter(({ text }) => text.includes("HOSTNAME_PATTERN")).map(({ path }) => path);
    expect(named).toEqual([THE_RULE]);
  });

  /**
   * The modules that carry a hostname-shaped regex of their own, and why each is a different question.
   *
   * **Frozen, and honest about what the detector is.** It matches two spellings — the label class
   * `[a-z0-9-]{1,63}` and the dotted-label form — so a third spelling escapes it. That is why this list
   * exists rather than a bare assertion of zero: a reader should not take the gate for more than it is.
   */
  const OWN_HOSTNAME_SHAPE: Readonly<Record<string, string>> = {
    "packages/cli/src/project/deploy.ts":
      "classifies tokens in wrangler's own stdout — asks whether a printed trigger looks like a host, never whether a configured domain is valid (#683)",
  };

  test("**and nothing writes the label shape out for itself**", () => {
    // Two spellings: the label class, and the dotted-label form the same rule is usually written as.
    const shapes = [/\[a-z0-9-\]\{1,63\}/, /\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?/];
    const copies = SOURCES.filter(
      ({ path, text }) =>
        path !== THE_RULE && !(path in OWN_HOSTNAME_SHAPE) && shapes.some((shape) => shape.test(text)),
    ).map(({ path }) => path);
    expect(copies).toEqual([]);
  });

  test("and every module excused for carrying its own really still carries one", () => {
    const shapes = [/\[a-z0-9-\]\{1,63\}/, /\[a-z0-9\]\(\?:\[a-z0-9-\]\*\[a-z0-9\]\)\?/];
    const stale = Object.keys(OWN_HOSTNAME_SHAPE).filter((path) => {
      const text = SOURCES.find((s) => s.path === path)?.text;
      return text === undefined || !shapes.some((shape) => shape.test(text));
    });
    expect(stale).toEqual([]);
  });

  test("the rule's own module reads the pattern only inside `publicHostnameProblem`", () => {
    const text = SOURCES.find(({ path }) => path === THE_RULE)?.text ?? "";
    const lines = text.split("\n");
    const uses = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes("HOSTNAME_PATTERN"))
      .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
      .filter(({ line }) => !/^const HOSTNAME_PATTERN\s*=/.test(line.trim()));
    expect(uses).toHaveLength(1);
    const start = lines.findIndex((line) => line.startsWith("export function publicHostnameProblem"));
    const end = lines.findIndex((line, index) => index > start && line === "}");
    expect(start).toBeGreaterThan(-1);
    expect(uses[0]?.number).toBeGreaterThan(start);
    expect(uses[0]?.number).toBeLessThan(end + 1);
  });

  test("it is not exported, so no module can reach around the function", () => {
    const text = SOURCES.find(({ path }) => path === THE_RULE)?.text ?? "";
    expect(text).not.toMatch(/export\s+const\s+HOSTNAME_PATTERN/);
  });
});

/**
 * **No reader catches a refused declaration (#665).**
 *
 * `loadWorkerDomains` throws with the field named, and that throw is the answer. An invalid domain is a
 * config error: the adopter said what they meant, the kit will not take it, and nothing downstream can be
 * generated from it — so the command stops and they fix the field.
 *
 * Eleven readers used to disagree about this, and the softer answers were each tried and each lied.
 * Falling back to the route resolved an address nobody declared. Reporting it as a drift finding and
 * carrying on had to say something about every *other* environment, because `WorkerDomains` parses whole,
 * and every version of that sentence was false for an environment whose own block was fine.
 *
 * **What a reader may still forgive is the config not importing.** That is a different fact — nobody
 * could ask — so the load may sit in a `try` while this call may not. Stated as the invariant rather than
 * as a list of readers, because the list is what goes stale: `#665` was filed because a caller nobody had
 * reasoned about accepted what another refused.
 */
describe("a refused declaration is never caught", () => {
  /** Every `loadWorkerDomains(` call that sits inside a `try { … }` block, by line. */
  function swallowed(text: string): number[] {
    const lines = text.split("\n");
    const inside: number[] = [];
    const openTries: number[] = [];
    let depth = 0;
    for (const [index, line] of lines.entries()) {
      const before = depth;
      for (const char of line) {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
      }
      if (/\btry\s*\{/.test(line)) openTries.push(before + 1);
      while (openTries.length > 0 && depth < (openTries.at(-1) ?? 0)) openTries.pop();
      if (openTries.length > 0 && /loadWorkerDomains\(/.test(line)) inside.push(index + 1);
    }
    return inside;
  }

  /** `.catch(() => undefined)` on the promise, which is the same swallow written as a chain. */
  const catchesOnThePromise = (text: string): boolean =>
    /loadWorkerDomains\([\s\S]{0,200}?\)\s*\.catch\(/.test(text) ||
    /loadWorkerDomains\(await load\([\s\S]{0,80}?\)\)[\s\S]{0,40}?\.catch\(/.test(text);

  const readers = SOURCES.filter(
    // The one definition site by its full path, not every file that happens to be called `config.ts`.
    ({ path, text }) => /loadWorkerDomains\(/.test(text) && path !== "packages/cli/src/project/config.ts",
  );

  test("the scan found the readers it is about", () => {
    expect(readers.length).toBeGreaterThanOrEqual(10);
  });

  test("the scan can see a swallow when there is one", () => {
    // Non-vacuous, planted in a string rather than in a file, so the proof runs on every commit and no
    // module has to carry a defect to keep this test honest.
    const planted = [
      "function f() {",
      "  try {",
      "    return loadWorkerDomains(config);",
      "  } catch {",
      "    return undefined;",
      "  }",
      "}",
    ].join("\n");
    expect(swallowed(planted)).toEqual([3]);
    expect(catchesOnThePromise("const d = loadWorkerDomains(await load(dir)).catch(() => undefined);")).toBe(true);
  });

  test("**and no reader has one**", () => {
    const swallowing = readers
      .filter(({ text }) => swallowed(text).length > 0 || catchesOnThePromise(text))
      .map(({ path, text }) => `${path}:${swallowed(text).join(",")}`);
    expect(swallowing).toEqual([]);
  });
});
