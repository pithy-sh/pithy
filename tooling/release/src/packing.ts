// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a published tarball must and must not hold, checked on the artifact rather than on the manifest.
 *
 * ## Why not just read `files`
 *
 * **`files` does not fail on a missing path.** That is the lesson `packages/cli/scripts/verifyPack.ts`
 * was built on, and it applies here unchanged: a `files` array naming `pithy.manifest.json` passes every
 * static check whether or not the file exists, and the tarball that reaches an adopter is the only thing
 * that knows the difference. `manifests.test.ts` holds the declaration; this holds the result.
 *
 * ## What the first pack of this repository actually contained
 *
 * Nothing declared `files` except `@pithy-sh/cli` and `@pithy-sh/payments`, so `npm publish` took
 * whatever git did not ignore. `@pithy-sh/core` shipped 127 test files out of 264 — half the tarball.
 * `@pithy-sh/payments` shipped 93, *while declaring a `files` field*, because it listed what to include
 * and never the negation that leaves the tests out. A field that looks right and is wrong is the case
 * for checking the artifact.
 *
 * ## The three faults, and the one deliberate exception
 *
 * A test file, a build leftover, and a missing capability manifest. The exception is `templates/`: the
 * CLI vendors a starter an adopter scaffolds into their own repository, and a starter that arrives with
 * no test teaches them the wrong thing. Those files are held to the git index by `verifyPack.ts`, so
 * they are somebody's post-condition already.
 *
 * A missing manifest is the one that costs an adopter silently. The CLI resolves every capability's
 * manifest from `node_modules/@pithy-sh/*` (`capabilities/reconcile.ts`), so a package that ships
 * without one is a capability `pithy add` cannot see — and it exits 0.
 */

/** A packed package, as `npm pack --dry-run --json` describes it. */
export interface PackedPackage {
  /** The npm package name, for the fault line. */
  name: string;
  /** Every path in the tarball, relative to the package root. */
  entries: string[];
  /** Whether this package has a `pithy.manifest.json` that must reach the adopter. */
  expectsManifest: boolean;
  /**
   * The package's own `files` field, if it declares one.
   *
   * Checked because **`files` does not fail on a missing path** — the reason this whole module is on
   * the artifact rather than the manifest. A declared entry that matched nothing is exactly the miss
   * the field cannot report about itself, and `@pithy-sh/payments` has one: its browser build is
   * git-ignored and only exists after `bun run build`, so a pack ordered before the build ships a
   * `files` field naming a file that is not there, silently.
   */
  declared?: string[];
}

/**
 * A vendored template ships whole, tests included.
 *
 * The one path where a `.test.ts` is correct — see the header. Anything else is a test file an adopter
 * downloads and never runs.
 */
const VENDORED = "templates/";

/**
 * A test file, in any extension this repo writes them in.
 *
 * Spelled `.test.ts` alone, it missed `@pithy-sh/ui-react` entirely — the one package whose tests are
 * TSX — and eleven of them shipped under a gate reporting every package clean.
 */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Build and tooling files a `files` field excludes. Present, they mean the field is missing or wrong. */
const LEFTOVER = /^(tsconfig[^/]*\.json|vitest[^/]*\.(ts|js)|biome\.jsonc|[^/]*\.tsbuildinfo)$/;

/** How many offending paths to name before the line stops being readable. */
const NAMED = 5;

function list(paths: string[]): string {
  const shown = paths.slice(0, NAMED).join(", ");
  return paths.length > NAMED ? `${shown}, and ${paths.length - NAMED} more` : shown;
}

/** Everything wrong with one packed package, as sentences. Empty means it is fit to publish. */
export function packFaults(packed: PackedPackage): string[] {
  const faults: string[] = [];

  const tests = packed.entries.filter((path) => TEST_FILE.test(path) && !path.startsWith(VENDORED));
  if (tests.length > 0) {
    faults.push(
      `${packed.name} ships ${tests.length} test files: ${list(tests)}. Add "!src/**/*.test.*" to its files field.`,
    );
  }

  const leftovers = packed.entries.filter((path) => LEFTOVER.test(path));
  if (leftovers.length > 0) {
    faults.push(`${packed.name} ships build leftovers: ${list(leftovers)}. Declare a files field.`);
  }

  if (packed.expectsManifest && !packed.entries.includes("pithy.manifest.json")) {
    faults.push(
      `${packed.name} ships no pithy.manifest.json. The CLI resolves capability manifests from the adopter's node_modules, so pithy add cannot see this capability without it.`,
    );
  }

  if (!packed.entries.some((path) => path.startsWith("src/"))) {
    faults.push(`${packed.name} ships no src. Its exports map resolves ./src/*, so nothing in it can be imported.`);
  }

  // A declared entry is a path or a directory prefix; either way something under it must have landed.
  // Negations are what a field says to leave out, so they are expected to match nothing.
  const unreached = (packed.declared ?? []).filter(
    (entry) => !entry.startsWith("!") && !packed.entries.some((path) => path === entry || path.startsWith(`${entry}/`)),
  );
  if (unreached.length > 0) {
    faults.push(
      `${packed.name} declares files that reached the tarball empty: ${list(unreached)}. Either the path is wrong or it is built after this check runs.`,
    );
  }

  return faults;
}
