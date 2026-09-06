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
  /**
   * The manifest as it appears **inside the tarball**, for the fields a consumer installs from.
   *
   * Read from the packed artifact rather than from the source tree, because the two can differ — that
   * is the whole premise of a pack-time rewrite, and the absence of one is what shipped `workspace:*`
   * to the registry twice.
   */
  manifest?: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    /** The executables this package links into `node_modules/.bin`, if any. */
    bin?: string | Record<string, string>;
  };
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

/**
 * The workspace protocol — a Bun, pnpm and yarn convention that **npm does not implement**.
 *
 * Measured, not assumed: `npm pack` leaves `workspace:*` verbatim from the package directory *and*
 * from the repository root with `-w`. Changesets publishes through `npm publish`, so 20 of the 22
 * packages in `0.1.0` and `0.1.1` shipped a dependency range no registry can resolve, and every one of
 * them was uninstallable. Only `core` and `ui-react`, which depend on no sibling, survived.
 *
 * Nothing inside this repository could have caught it. Every test here runs in the workspace, where
 * `workspace:*` resolves perfectly — the range is only wrong once it leaves.
 */
const WORKSPACE_PROTOCOL = /^workspace:/;

/**
 * A source module a consumer can deep-import: under `src`, TypeScript, not a declaration, not a test.
 *
 * `.d.ts` is excluded because it is not a module — `cloudflare-test.d.ts` is an ambient declaration
 * nothing imports, and building it as an entry emits an empty `cloudflare-test.d.js`.
 *
 * A test is excluded even though the fault above already refuses it from the tarball, because the fault
 * *reports* a test rather than removing it: without this, one package shipping its tests reported a
 * second fault demanding those tests be built, which is the opposite of what the first one asked for.
 * Two faults disagreeing about the same file is worse than either alone.
 */
const SOURCE_MODULE = /^src\/(?!.*\.d\.ts$)(?!.*\.test\.).*\.tsx?$/;

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
    faults.push(
      `${packed.name} ships no src. Its declaration and source maps point back into it, so an adopter stepping into this package lands nowhere.`,
    );
  }

  // **The one that makes `exports` true — #476.** Every package's map resolves `./src/*` onto
  // `./dist/*.js` and `./dist/*.d.ts`, so a tarball with no build is 22 packages' worth of deep imports
  // resolving to nothing, discovered by whoever installed it. `dist` is gitignored, which is exactly
  // how it goes missing: `npm pack` falls back to `.gitignore` for any package that forgets to name
  // `dist` in `files`, and says nothing about it.
  if (!packed.entries.some((path) => path.startsWith("dist/"))) {
    faults.push(
      `${packed.name} ships no dist. Its exports map resolves ./src/* onto ./dist/*.js, so every import of it fails at install time. Add "dist" to its files field — it is gitignored, so npm drops it otherwise.`,
    );
  }

  // Both halves, per module. A published module with JavaScript and no declaration is an `any` in the
  // adopter's editor; with a declaration and no JavaScript it is a type that cannot be imported. The
  // source is what the map is keyed on, so it is the side asked from.
  const built = new Set(packed.entries.filter((path) => path.startsWith("dist/")));
  const halfBuilt = packed.entries
    .filter((path) => SOURCE_MODULE.test(path))
    .flatMap((path) => {
      const stem = path.replace(/^src\//, "").replace(/\.tsx?$/, "");
      return [`dist/${stem}.js`, `dist/${stem}.d.ts`].filter((half) => !built.has(half));
    });
  if (halfBuilt.length > 0) {
    faults.push(
      `${packed.name} ships ${halfBuilt.length === 1 ? "a published module" : `${halfBuilt.length} published modules`} missing a half: ${list(halfBuilt)}. A module needs its .js and its .d.ts, or it must be kept out of the tarball too.`,
    );
  }

  // **A `bin` an adopter runs must be built JavaScript that is actually in the tarball — #474.**
  // `@pithy-sh/cli` linked `./src/bin.ts`: raw TypeScript behind `#!/usr/bin/env bun`, so `pithy`
  // installed for everyone and started for nobody without Bun. Two separate faults, and both are
  // invisible from inside a workspace — a linked checkout resolves by realpath, outside `node_modules`,
  // where the shebang never runs. The shebang itself is the clean room's to check, because it is a
  // property of the file's first line and of the machine's PATH; this is the part a tarball can answer.
  const bins = Object.values(
    typeof packed.manifest?.bin === "string" ? { default: packed.manifest.bin } : (packed.manifest?.bin ?? {}),
  ).map((target) => target.replace(/^\.\//, ""));
  const rawEntry = bins.filter((target) => /\.[cm]?tsx?$/.test(target));
  if (rawEntry.length > 0) {
    faults.push(
      `${packed.name} links ${list(rawEntry)} as a bin, which is TypeScript. Node cannot run it under node_modules — point bin at the built file.`,
    );
  }
  const missingBin = bins.filter((target) => !packed.entries.includes(target));
  if (missingBin.length > 0) {
    faults.push(
      `${packed.name} links ${list(missingBin)} as a bin and the tarball does not carry it. The install links a shim to nothing.`,
    );
  }

  // A declared entry is a path or a directory prefix; either way something under it must have landed.
  // Negations are what a field says to leave out, so they are expected to match nothing.
  const unreached = (packed.declared ?? []).filter(
    (entry) => !entry.startsWith("!") && !packed.entries.some((path) => path === entry || path.startsWith(`${entry}/`)),
  );
  // A consumer installs `dependencies` and `peerDependencies`. A devDependency is never installed by
  // one, and several here name private packages that have no published range to point at.
  const unresolvable = [
    ...Object.entries(packed.manifest?.dependencies ?? {}),
    ...Object.entries(packed.manifest?.peerDependencies ?? {}),
  ].filter(([, range]) => WORKSPACE_PROTOCOL.test(range));
  if (unresolvable.length > 0) {
    faults.push(
      `${packed.name} ships ${unresolvable.length} dependencies on the workspace protocol, which npm does not resolve: ${list(unresolvable.map(([name, range]) => `${name}@${range}`))}. Give them a concrete range.`,
    );
  }

  if (unreached.length > 0) {
    faults.push(
      `${packed.name} declares files that reached the tarball empty: ${list(unreached)}. Either the path is wrong or it is built after this check runs.`,
    );
  }

  return faults;
}
