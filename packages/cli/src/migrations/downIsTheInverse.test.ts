// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/** The packages directory, resolved the way `orders.test.ts` resolves it — three levels up from here. */
const PACKAGES = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **Every index a migration creates, its `down` drops.**
 *
 * SQLite takes an index with the table it is on, so an explicit `dropIndex` is redundant against a `down`
 * that drops the table — and every capability in this kit writes one anyway, because a `down` that reads
 * as the reverse of its `up` is one a reader can check against it line by line.
 *
 * **Two had drifted before this test existed**, and both looked deliberate rather than forgotten:
 * `@pithy-sh/organization` created six indexes and dropped none, `@pithy-sh/secrets` created one and
 * dropped none. Fourteen other migrations matched. That is the shape of a convention nobody is enforcing
 * — correct everywhere it was looked at, and silently optional.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * Counts per file, not names. A name-level check would have to resolve the identifier `CamelCasePlugin`
 * renames and would break on a migration that creates an index inside a loop; a count catches the case
 * that actually happens, which is a `down` that never mentions indexes at all.
 *
 * It also says nothing about **order** — indexes before tables, children before parents. That is real and
 * it is each migration's own test's to make, because only that test knows which table references which.
 *
 * ## Why the redundancy is worth keeping rather than deleting everywhere
 *
 * The cheaper side to be wrong on. Dropping an index that SQLite was going to drop costs a statement in a
 * rollback nobody runs often; *not* dropping one the day a `down` stops dropping its table leaves a name
 * behind that collides on the next `up`, and the failure surfaces as a migration that cannot re-run.
 */

/** Every `0*.ts` migration in every package's `src`, as text. Not `dist` — the built copies have no bodies. */
function migrationSources(): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const file of sourcePaths(joinPath(PACKAGES, pkg.name, "src"))) {
      if (!/\/migrations\/0[^/]*\.ts$/.test(file) || file.endsWith(".test.ts")) continue;
      const source = readSource(file);
      if (source !== null) found.push({ file: file.slice(PACKAGES.length + 1), source });
    }
  }
  return found;
}

describe("a migration's down is the inverse of its up", () => {
  const migrations = migrationSources();

  test("the scan found the migrations, so the assertion below is over something", () => {
    // A glob that matched nothing is the same green as a tree that behaves.
    expect(migrations.length).toBeGreaterThan(10);
    expect(migrations.map((m) => m.file)).toContain("organization/src/migrations/0001_init.ts");
  });

  test("**every index created is dropped**", () => {
    const drifted = migrations
      .map(({ file, source }) => ({
        file,
        created: (source.match(/\.createIndex\(/g) ?? []).length,
        dropped: (source.match(/\.dropIndex\(/g) ?? []).length,
      }))
      .filter((entry) => entry.created !== entry.dropped);

    expect(
      drifted,
      "A migration creates indexes its `down` does not drop. SQLite would take them with the table, but every other migration here writes the inverse explicitly — match it, or this file is the place to argue why not.",
    ).toEqual([]);
  });
});
