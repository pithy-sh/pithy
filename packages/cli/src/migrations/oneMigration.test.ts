// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/**
 * **Until the first publish, a capability's schema is one migration per database — not a chain.**
 *
 * A migration chain preserves one thing: the ability to walk a database that already holds rows from an
 * old shape to a new one. Nothing in this repository has ever been published — every package sits at
 * `0.0.0`, `npm view @pithy-sh/core version` is a 404, and the only adopter is `pithy-sh/dashboard`,
 * whose dev database can be recreated in two minutes. So no database anywhere holds a row that a second
 * migration would have to carry across, and a `0002` here is a step from a shape that never ran to a
 * shape that never shipped — two `down`s, two test suites, and a history that will never be replayed.
 * Git already records when each column arrived, which is the only thing a chain actually preserves.
 *
 * `0001_init` is meant to **be** the capability's schema. Three capabilities had drifted off that
 * (#276), and nothing said so until somebody looked.
 *
 * **The condition is what makes the rule true, and it is checked rather than assumed.** A package whose
 * `version` is no longer `0.0.0` has been released, so its migrations may have run somewhere real — and
 * a migration that has run somewhere real is history, which is not edited. This gate skips such a
 * package, and goes quiet on its own the day the first version is cut. See `CONTRIBUTING.md`
 * §Migrations, which states the rule for a reader who arrives after that.
 *
 * **Two structural facts, not a list of filenames.** A deny-list of `0002_*` would have to carry an
 * exception for `@pithy-sh/email`, which legitimately ships `0001_init.ts` *and* `0001_suppressions.ts`
 * — two databases (the app `DB` and the durable `EMAIL_SUPPRESSIONS`), not two steps against one — and a
 * gate that has to be argued with on every legitimate case is worse than none. So the invariant is
 * stated as:
 *
 * 1. **Every authored migration is numbered `0001`.** The number orders a migration *within its
 *    database* (`createMigrationRegistry` composes `0350_media_0001_init`), so a `0002` is by
 *    definition a second step against a database that already has a first.
 * 2. **A package authors no more migrations than it has databases.** A capability declares one
 *    `<NAME>_MIGRATION_ORDER` per database it owns — orders are allocated per database, which is why
 *    `EMAIL_SUPPRESSIONS_MIGRATION_ORDER` exists beside `EMAIL_MIGRATION_ORDER` — so the count of those
 *    constants is the count of databases. Email's pair passes because it has two of both; a second
 *    migration slipped in at `0001_*` against one database fails on the count.
 *
 * **Authored, not generated.** `@pithy-sh/auth`'s `pluginTables.ts` and `@pithy-sh/media`'s `extend.ts`
 * synthesise a migration per adopter, from the plugins or the extension schema *that adopter* composes.
 * They are not this repository's schema and no author edits them, so they are outside the rule — and
 * outside this scan for free, because a generated migration has no numbered file to find.
 */

/** `packages/` — this file lives at `packages/cli/src/migrations/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** `0001_init.ts` — an authored migration. Its own test file is not one, and neither is `extend.ts`. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.ts$/;

/** `const X_MIGRATION_ORDER = 300`, exported or not — one per database the package owns. */
const ORDER_DECLARATION = /^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*_MIGRATION_ORDER\s*=\s*\d+\s*;/gm;

interface PackageMigrations {
  /** The package directory name under `packages/`, e.g. `audit`. */
  readonly name: string;
  /** Its declared `version`, or null when it has no readable `package.json`. */
  readonly version: string | null;
  /** Authored migration files, as `<number>/<basename>` paths relative to the package. */
  readonly files: ReadonlyArray<{ readonly number: string; readonly path: string }>;
  /** How many databases it declares a migration order for. */
  readonly databases: number;
}

/** What every package under `packages/` authors by way of migrations. */
function scan(): PackageMigrations[] {
  const scanned: PackageMigrations[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    const files: Array<{ number: string; path: string }> = [];
    let databases = 0;
    for (const file of sourcePaths(join(PACKAGES, pkg.name, "src"))) {
      const source = readSource(file);
      if (source === null) continue;
      databases += [...source.matchAll(ORDER_DECLARATION)].length;
      // A migration lives in a `migrations/` directory. Nothing else in the tree is numbered this way,
      // but requiring the directory keeps a future `0001_something.ts` elsewhere from being read as one.
      if (dirname(file).split(sep).at(-1) !== "migrations") continue;
      const match = MIGRATION_FILE.exec(basename(file));
      if (match?.[1]) files.push({ number: match[1], path: file.slice(PACKAGES.length + 1) });
    }
    if (files.length === 0 && databases === 0) continue;
    scanned.push({ name: pkg.name, version: versionOf(pkg.name), files, databases });
  }
  return scanned;
}

/** A package's declared version, or null when there is no readable `package.json`. */
function versionOf(pkg: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(PACKAGES, pkg, "package.json"), "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** Never released, so no migration of its has run anywhere a chain would have to be replayed against. */
const isUnpublished = (pkg: PackageMigrations): boolean => pkg.version === "0.0.0";

/**
 * **The condition flipped on 2026-09-05.** All 22 packages were released at `0.1.0`, so every chain
 * here is now history and append-only, and the expectation that asserted "nothing is published yet" has
 * been deleted as it instructed. The rest stays, and it is not vacuous: every test below filters on
 * {@link isUnpublished}, so the rule goes dormant for what has shipped and wakes for the next capability
 * that lands at `0.0.0` — which is exactly the window it was written for.
 */
describe("one migration per capability per database, while unpublished", () => {
  const scanned = scan();

  test("the tree is actually scanned — a gate that finds nothing passes everything", () => {
    // The failure this file could have shipped in silence: a path that stopped resolving, a walk that
    // returned nothing, and a green suite asserting about the empty set.
    expect(scanned.length).toBeGreaterThan(5);
    expect(scanned.flatMap((pkg) => pkg.files).length).toBeGreaterThan(5);
  });

  test("no unpublished capability authors a migration past 0001", () => {
    const past = scanned
      .filter(isUnpublished)
      .flatMap((pkg) => pkg.files.filter((file) => file.number !== "0001").map((file) => file.path))
      .sort();
    expect(
      past,
      "Nothing here is published, so this schema has never run anywhere and a second migration is a chain nobody will replay. Fold it into 0001 and extend that migration's test. Once a version is cut this gate goes quiet and the chain becomes append-only — see CONTRIBUTING.md §Migrations.",
    ).toEqual([]);
  });

  test("no unpublished capability authors more migrations than it has databases", () => {
    // What the number alone cannot see: two files both numbered 0001 are two databases only if the
    // package declares two. `@pithy-sh/email` does — one order for the app `DB`, one for the durable
    // `EMAIL_SUPPRESSIONS` — which is why its pair is correct and passes here structurally rather than
    // by being named as an exception.
    const over = scanned
      .filter(isUnpublished)
      .filter((pkg) => pkg.files.length > pkg.databases)
      .map((pkg) => `${pkg.name}: ${pkg.files.length} migrations, ${pkg.databases} database(s)`)
      .sort();
    expect(
      over,
      "A capability owns one database per declared <NAME>_MIGRATION_ORDER, and while unpublished each gets exactly one migration. Two against one database is a chain — fold them.",
    ).toEqual([]);
  });

  test("email ships two migrations because it owns two databases", () => {
    // The case the rule must not break, asserted from the other direction: the one package whose pair of
    // `0001`s is correct. If this ever fails, the two tests above are checking something else.
    const email = scanned.find((pkg) => pkg.name === "email");
    expect(email?.files.map((file) => basename(file.path)).sort()).toEqual(["0001_init.ts", "0001_suppressions.ts"]);
    expect(email?.databases).toBe(2);
  });
});
