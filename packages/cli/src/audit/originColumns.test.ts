// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/**
 * Origin belongs in its columns, never back in the `metadata` bag.
 *
 * Before the origin columns existed, emitters that cared about where an event came from smuggled it
 * into the free-form JSON: `packages/cli/src/project/deploy.ts` wrote
 * `metadata: { worker: …, env: … }`. That is the failure mode this guards, and it is worse than having
 * no origin at all — a key only *some* emitters set makes a query over it look like it worked. The
 * columns are stamped by the recorder precisely so no call site has to remember and none can differ.
 *
 * A cross-package `node:fs` scan rather than an in-package `import.meta.glob`, matching
 * `capabilities/secretBackends.test.ts` and `migrations/orders.test.ts`: the rule spans every package
 * that emits (`core`, `auth`, `payments`, `testers`, `support`, and this one), and `@pithy-sh/cli` must
 * not hard-depend on the optional capability packages to police them. Text, therefore, not imports.
 *
 * (Paths in these comments avoid a literal star-slash — it would close the comment block.)
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");

/**
 * The keys that name an event's origin. `env` is here alongside `environment` because it is what the
 * old workaround actually used — banning only the column's own spelling would leave the exact key that
 * motivated this test perfectly legal.
 */
const ORIGIN_KEYS = new Set(["project", "environment", "env", "worker"]);

/**
 * Every non-test source file under each package's own `src` directory.
 *
 * The traversal is `ci/sourceFiles.ts`, the one walk over this tree's own source — so this reader gets the
 * hardening the shared walker has accumulated (#185, #192) rather than a private copy of the walk that gets
 * none of it (#202). Listing `packages/` itself stays here: that is one directory, not a traversal.
 */
function sourceFiles(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    found.push(...sourcePaths(join(PACKAGES, pkg.name, "src")));
  }
  return found;
}

/**
 * The source of every `metadata: { … }` object literal in a file, brace-balanced.
 *
 * Balanced rather than a single regex, because a metadata bag routinely nests (`{ error: { code } }`)
 * and a lazy `\{[^}]*\}` would stop at the first inner brace and read the rest as ordinary text — a
 * scan that silently under-matches is the way a meta-test becomes decorative.
 */
function metadataLiterals(source: string): string[] {
  const literals: string[] = [];
  const opener = /\bmetadata:\s*\{/g;
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
    }
    if (depth === 0) literals.push(source.slice(match.index + match[0].length, index - 1));
  }
  return literals;
}

/**
 * The keys written at the top level of one object-literal body — **including shorthand**.
 *
 * Shorthand is the whole reason this needs saying. The first version of this matched only `key:` with a
 * colon, so `metadata: { env }` — the exact form seven of the sites it was written to catch had used —
 * sailed straight past it. The test passed with a dozen live violations of its own rule, which is worse
 * than not having written it: a green meta-test reads as proof.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let line = "";
  const take = (entry: string): void => {
    const trimmed = entry
      .trim()
      .replace(/\/\/[^\n]*$/gm, "")
      .trim();
    if (trimmed === "" || trimmed.startsWith("...")) return;
    const written = trimmed.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*:/);
    if (written?.[1]) {
      keys.push(written[1]);
      return;
    }
    // `{ env }` — the property name is the whole entry.
    const shorthand = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
    if (shorthand?.[1]) keys.push(shorthand[1]);
  };
  for (const character of `${body},`) {
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      take(line);
      line = "";
      continue;
    }
    line += character;
  }
  return keys;
}

describe("audit origin stays in its columns", () => {
  const files = sourceFiles();

  it("scans a real set of files, so the rule below is not vacuous", () => {
    // A walk that silently matched nothing would make every assertion here pass forever.
    expect(files.length).toBeGreaterThan(400);
  });

  it("finds the metadata literals it is meant to police", () => {
    // And the extractor has to actually extract. If `metadata:` were renamed, or the brace matcher
    // broke, the offender list below would be empty for the wrong reason.
    const withMetadata = files.filter((file) => metadataLiterals(readSource(file) ?? "").length > 0);
    expect(withMetadata.length).toBeGreaterThan(5);
  });

  it("reads shorthand properties, not just written-out ones", () => {
    // The extractor's own regression guard. `{ env }` and `{ env: x }` mean the same thing and must both
    // be seen; a spread is not a key it can resolve, and a nested one is not this literal's.
    expect(topLevelKeys("name, env")).toEqual(["name", "env"]);
    expect(topLevelKeys("env: options.drop.env, migrationsReverted")).toEqual(["env", "migrationsReverted"]);
    expect(topLevelKeys("...rest, worker")).toEqual(["worker"]);
    expect(topLevelKeys("error: { project: x }")).toEqual(["error"]);
  });

  it("no emitter writes an origin key into the metadata bag", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const literal of metadataLiterals(readSource(file) ?? "")) {
        for (const key of topLevelKeys(literal)) {
          if (ORIGIN_KEYS.has(key)) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: metadata.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
