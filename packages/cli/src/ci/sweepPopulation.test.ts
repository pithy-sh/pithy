// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { isTestFile, readSource, sourcePaths } from "./sourceFiles";

/**
 * **A sweep over a population asserts what the population is.**
 *
 * This is the gate over the gates, and the taxonomy it exists for is worth carrying into any gate
 * review, because every can't-fail test this repository has shipped is one of eight shapes (#326):
 *
 * 1. A rule restated as a shorter forbidden list, missing a member.
 * 2. A check derived from its own subject — the permitted set read off the thing under test.
 * 3. A comparison filtered until it is tautological.
 * 4. An expected value built from the fields being compared, so an entry vanishes from both sides.
 * 5. No gate at all, where a sibling capability has one.
 * 6. A sweep run over a parsed copy, so a schema strips the thing being hunted.
 * 7. A set under test computed by calling the function under test.
 * 8. An anti-vacuity guard far below the real population.
 *
 * Shapes 2 and 7 are the same mistake at different altitudes, and they are the most common.
 *
 * ## What this file checks
 *
 * `import.meta.glob` is how a test sweeps its own package: eagerly import every module, then assert
 * something about every schema, export or source it found. It is the right shape — a module added next
 * year is covered without anybody remembering — and it has one failure mode. **A glob that matches
 * nothing produces no findings, and no findings is what passing looks like.** A moved `src`, a
 * mistyped pattern, a package reorganised around it: the file stays green, over nothing, and the louder
 * it is about the invariant it protects the longer nobody re-reads it.
 *
 * So every sweep is partitioned here, exactly. A new one lands in neither list and this fails, which is
 * the moment its author is asked the question. The unguarded ones are **listed rather than excused** —
 * seventeen of them today — so closing one fails this file until the list shrinks with it, and the debt
 * is visible instead of being a sentence in an issue nobody reopens.
 *
 * The guard itself is *near-exact*, not a comfortable floor: `toBeGreaterThan(5)` against twenty-seven
 * real subcommands is not a guard, it is the shape of one.
 */

/** The repo's `packages/`, from this file — `packages/cli/src/ci` is four levels down. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..", "..", "packages");

/**
 * The sweep primitive. A test calling this imports a whole package and asserts over what came back.
 *
 * Assembled rather than written out, so this file does not match its own scan. Naming the needle in the
 * scanner is the smallest possible version of shape 2 — a check derived from its own subject.
 */
const SWEEP = `import.meta.${"glob("}`;

/**
 * Sweeps that assert what they found. **A frozen literal**, and the shorter of the two lists.
 *
 * `core` and `testers` count the schemas they walked; `vite` counts the modules; `audit` and core's
 * Worker-safety scan pin both, near-exactly, as of #326. #338's retry-classification gate was enrolled
 * here when it landed — it pins its entrypoints in both directions, so it counts.
 */
const GUARDED = [
  "audit/src/schema-descriptions.test.ts",
  "core/src/schema-descriptions.test.ts",
  "core/src/worker-safety.test.ts",
  "core/src/workflow/retryClassification.test.ts",
  "testers/src/schema-descriptions.test.ts",
  "vite/src/schema-descriptions.test.ts",
];

/**
 * Sweeps that do not — every one of them green over an empty glob. **Open, tracked, and not a licence.**
 *
 * Fifteen are the per-package `schema-descriptions` sweep, which is the same file copied across the
 * kit; two are core's own. They are debt rather than a decision: the fix is one assertion each, and it
 * belongs to whoever is next in the file. Removing a name here without adding it to {@link GUARDED}
 * fails this test, which is the point.
 */
const UNGUARDED = [
  "auth/src/schema-descriptions.test.ts",
  "cloudflare/src/schema-descriptions.test.ts",
  "core/src/controlPlane/wire.test.ts",
  "core/src/logger/boundary.test.ts",
  "email/src/schema-descriptions.test.ts",
  "leaderboard/src/schema-descriptions.test.ts",
  "ledger/src/schema-descriptions.test.ts",
  "matchmaking/src/schema-descriptions.test.ts",
  "media/src/schema-descriptions.test.ts",
  "multiplayer/src/schema-descriptions.test.ts",
  "payments/src/schema-descriptions.test.ts",
  "rating/src/schema-descriptions.test.ts",
  "secrets/src/schema-descriptions.test.ts",
  "storage/src/schema-descriptions.test.ts",
  "support/src/schema-descriptions.test.ts",
  "turnstile/src/schema-descriptions.test.ts",
  "vector/src/schema-descriptions.test.ts",
];

/**
 * Whether a file asserts the size of something.
 *
 * Deliberately generous about *what* is counted — a `.length`, or a counter the sweep incremented, are
 * both real answers and `core` uses the second — and deliberately strict about the matcher: a size
 * matcher is the only thing that can express "the population is the one I expected". `toEqual([])` is
 * the finding assertion, never the guard, which is exactly why fifteen files look thorough and are
 * not.
 *
 * Over-accepting is possible here, and it is bounded on purpose: the partition below is a frozen
 * literal, so a file this misreads shows up as a partition that no longer matches rather than as a hole.
 */
function assertsPopulation(source: string): boolean {
  return source
    .split("\n")
    .some(
      (line) =>
        /expect\(.*\)\s*\.\s*to(?:BeGreaterThan|BeGreaterThanOrEqual|HaveLength)\(/.test(line) ||
        /expect\(.*\.length.*\)\s*\.\s*toBe\(/.test(line),
    );
}

/** Every test file in the kit that sweeps its package with `import.meta.glob`, and whether it counts. */
function sweeps(): { path: string; guarded: boolean }[] {
  const found: { path: string; guarded: boolean }[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const path of sourcePaths(join(PACKAGES, pkg.name, "src"), { keep: isTestFile })) {
      const source = readSource(path);
      // The `declare global` block every one of these carries names `glob` but does not call it.
      if (source === null || !source.includes(SWEEP)) continue;
      found.push({ path: relative(PACKAGES, path).split("\\").join("/"), guarded: assertsPopulation(source) });
    }
  }
  return found.sort((left, right) => (left.path < right.path ? -1 : 1));
}

describe("every package-wide sweep says what it swept", () => {
  test("the walk finds the sweeps, so this gate is not itself vacuous", () => {
    // The gate over the gate over the gates. Twenty-two sweeps as this is written; a walk returning two
    // would make the partition below trivially satisfiable by shrinking both lists.
    expect(sweeps().length).toBe(GUARDED.length + UNGUARDED.length);
    expect(sweeps().length).toBeGreaterThanOrEqual(22);
  });

  test("each one is either counted, or named here as debt", () => {
    // Exact, both directions. A new sweep is in neither list and fails here — which is the whole point:
    // its author is asked, once, before the file has had time to be trusted.
    expect(
      sweeps().map(({ path }) => path),
      "A test sweeping its package with `import.meta.glob` is green over an empty glob. Assert what it found — near-exactly — and add it to GUARDED; or add it to UNGUARDED with the reason it is still debt.",
    ).toEqual([...GUARDED, ...UNGUARDED].sort());
  });

  test("and the ones that claim to count really do", () => {
    const counted = sweeps()
      .filter(({ guarded }) => guarded)
      .map(({ path }) => path);
    expect(counted, "A file in GUARDED that stopped asserting its population belongs in UNGUARDED.").toEqual(GUARDED);
  });

  test("the detector reads a size assertion, and reads a findings assertion as none", () => {
    // The gate over the gate. `assertsPopulation` deciding "yes" for a file that only asserts its
    // findings is how this whole file becomes decorative, and `expect(missing).toEqual([])` is exactly
    // the assertion fifteen unguarded sweeps do make.
    expect(assertsPopulation("expect(missing).toEqual([]);")).toBe(false);
    expect(assertsPopulation("expect(offenders).toEqual([]);\nexpect(found).toEqual(EXPECTED);")).toBe(false);
    expect(assertsPopulation("expect(Object.keys(modules).length).toBeGreaterThan(0);")).toBe(true);
    expect(assertsPopulation("expect(Object.keys(sources).length).toBeGreaterThanOrEqual(100);")).toBe(true);
    expect(assertsPopulation("expect(schemasChecked).toBeGreaterThan(0);")).toBe(true);
    expect(assertsPopulation("expect(files).toHaveLength(19);")).toBe(true);
    expect(assertsPopulation("expect(files.length).toBe(19);")).toBe(true);
  });
});
