// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, resolve, sep } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { isShippedSource, readSource, sourcePaths } from "./sourceFiles";

/**
 * **`zod`, `kysely` and `hono` are `peerDependencies` of every package that imports them, never
 * `dependencies`, and every package agrees on the range.**
 *
 * ## What goes wrong when they are not
 *
 * Two copies of a package whose classes carry private members are two *different types*, and the
 * diagnostic never says so:
 *
 * ```
 * Type 'Kysely<any>' is not assignable to type 'Kysely<any>'.
 *   Property '#private' refers to a different member that cannot be accessed from within type.
 * ```
 *
 * Both paths read identically unless you compare them character by character. `pithy-sh/dashboard` hit
 * it on the day it moved off a linked checkout onto published `0.1.2` (#477): it imports `zod` in 97
 * files, `kysely` in 49 and `hono` in 40, declared none of them, and had been symlinking all three out
 * of the kit's own `node_modules` — one copy, by construction — for exactly this reason. On npm that
 * stops being automatic, and an undeclared import resolves to whatever the installer hoisted.
 *
 * A `dependency` is the kit saying "I need some copy of this". A `peerDependency` is the kit saying "you
 * and I must share one", which is the true statement, and it is the one a package manager can act on:
 * npm, pnpm and bun all install a peer once, at the top, where the adopter's own import finds it too.
 *
 * ## Which packages, and why these three
 *
 * **Derived from the imports, never listed.** A package that imports one of them from shipped source
 * declares it; a package that does not, does not. Both directions are asserted, because a list of
 * packages would be a second thing to keep in step with the first — and "declare all three everywhere to
 * be safe" would pass a one-directional gate while making adopters install a Kysely for a Worker that
 * has no database.
 *
 * **Three, and the two near-misses are decisions rather than oversights.**
 *
 * `@hono/zod-validator` looks like a fourth and is not. Its types do not cross the published boundary —
 * measured: no `.d.ts` this repository emits references it, because a validator is consumed inside a
 * route definition and erased into the `Hono` app type that comes out. Two copies of it are harmless
 * *given* one copy of `hono` and one of `zod`, which is what the rule above secures. It stays a
 * dependency, which is what the kit needing some copy of it means.
 *
 * `kysely-d1` is named in exactly one emitted declaration — `D1MigrationDialect extends D1Dialect` — and
 * an adopter never constructs one. Peering it would make every project install a package to satisfy a
 * type they cannot name, to prevent a duplication that costs nothing: it peers `kysely` itself, so the
 * copy that matters is already the shared one.
 *
 * ## What this found on the way in
 *
 * `@pithy-sh/cli` imported `zod` from twenty-five shipped modules and declared it in `devDependencies`
 * alone — an undeclared runtime dependency, satisfied only because `@pithy-sh/core` happened to carry
 * `zod` transitively. Making core's a peer would have removed that cover and broken the CLI for every
 * adopter. `workersTypes.test.ts` had already recorded the sighting as the reason it kept itself to one
 * specifier; this is the rule that closes it.
 *
 * `@pithy-sh/cloudflare` declared `kysely` and imports it from no shipped source at all — only from a
 * test, and from two doc comments. It is a devDependency now, which is what a test-only use is.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/**
 * The three whose identity has to be shared between the kit and the adopter.
 *
 * Each is imported directly by adopters *and* appears in this repository's emitted declarations, which
 * is the pair of conditions that makes a second copy a type error rather than a duplicate.
 */
const SHARED = ["zod", "kysely", "hono"] as const;

/**
 * The one range every package states, per package. **Frozen literals.**
 *
 * Not derived from the manifests, because the property is that they agree — deriving the expectation
 * from one of them makes twenty-two manifests agree with whichever was read first, including on a value
 * that is wrong. `zod` is `^4.4.0` for the reason #475 records: `z.codec` does not exist below 4.1.0 and
 * `z.record` stopped enumerating symbol keys at 4.4.0, and the clean room installs at this floor.
 */
const RANGES: Record<(typeof SHARED)[number], string> = {
  zod: "^4.4.0",
  kysely: "^0.29.0",
  hono: "^4.13.2",
};

/** Every workspace member's directory, relative to the root. */
const MEMBERS = sourcePaths(REPO_ROOT, { keep: (name) => name === "package.json" })
  .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
  .filter((path) => /^packages\/[^/]+\/package\.json$/.test(path))
  .map((path) => path.slice(0, -"/package.json".length))
  .sort();

/** One member's manifest. */
function manifest(directory: string): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readSource(resolve(REPO_ROOT, directory, "package.json")) ?? "{}") as Record<
    string,
    Record<string, string> | undefined
  >;
}

/**
 * The bare specifiers a source file imports, comments blanked first.
 *
 * `from "kysely"` and `from "hono/http-exception"` are both the package; `from "./kysely"` is not, and
 * a mention inside a doc comment is not an import at all — which is the whole of what
 * `@pithy-sh/cloudflare` turned out to have.
 */
function imports(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of blankComments(source).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1] as string;
    if (specifier.startsWith(".") || specifier.startsWith("#")) continue;
    const scoped = specifier.startsWith("@");
    found.add(
      specifier
        .split("/")
        .slice(0, scoped ? 2 : 1)
        .join("/"),
    );
  }
  return found;
}

/** Which of {@link SHARED} a member imports from source it publishes. */
function importedBy(directory: string): string[] {
  const found = new Set<string>();
  for (const path of sourcePaths(resolve(REPO_ROOT, directory, "src"), { keep: isShippedSource })) {
    const text = readSource(path);
    if (text === null) continue;
    const specifiers = imports(text);
    for (const name of SHARED) if (specifiers.has(name)) found.add(name);
  }
  return [...found].sort();
}

describe("the runtime a package shares with its adopter is a peer dependency", () => {
  // The vacuity floor. An empty member list, or a walk that stopped finding imports, satisfies every
  // assertion below without reading a manifest.
  test("there are packages to check, and they do import these", () => {
    expect(MEMBERS.length).toBeGreaterThan(15);
    const all = new Set(MEMBERS.flatMap(importedBy));
    expect([...all].sort()).toEqual([...SHARED].sort());
  });

  test("a package that imports one declares it as a peer, and one it does not import it does not", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const used = new Set(importedBy(directory));
      const peers = manifest(directory).peerDependencies ?? {};
      for (const name of SHARED) {
        if (used.has(name) && peers[name] === undefined) {
          faults.push(`${directory} imports ${name} and does not declare it in peerDependencies`);
        }
        if (!used.has(name) && peers[name] !== undefined) {
          faults.push(`${directory} declares peer ${name} and imports it from no shipped source`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  test("none of them is a plain dependency, which is what would duplicate the copy", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const deps = manifest(directory).dependencies ?? {};
      for (const name of SHARED) {
        if (deps[name] !== undefined) faults.push(`${directory} declares ${name} as a dependency; it must be a peer`);
      }
    }
    expect(faults).toEqual([]);
  });

  test("every declaration states the same range", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const peers = manifest(directory).peerDependencies ?? {};
      for (const name of SHARED) {
        const declared = peers[name];
        if (declared !== undefined && declared !== RANGES[name]) {
          faults.push(`${directory} declares ${name}@${declared}, not ${RANGES[name]}`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  // A peer is not installed for the package that declares it, so without this the workspace could not
  // build or test itself — and the failure would arrive as a resolution error in an unrelated suite.
  test("every peer is a devDependency too, so the package can build and test itself", () => {
    const faults: string[] = [];
    for (const directory of MEMBERS) {
      const parsed = manifest(directory);
      const peers = parsed.peerDependencies ?? {};
      const dev = parsed.devDependencies ?? {};
      for (const name of SHARED) {
        if (peers[name] !== undefined && dev[name] === undefined) {
          faults.push(`${directory} peers ${name} and has no devDependency on it`);
        }
      }
    }
    expect(faults).toEqual([]);
  });
});
