// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readSource, sourcePaths } from "../ci/sourceFiles";

/**
 * Migration orders must be unique per database, across every capability the repo ships.
 *
 * `createMigrationRegistry` already enforces this — but only at the moment a project composes the
 * colliding pair, which is `pithy migrate` on an adopter's machine. Two collisions (auth/media at 300,
 * rating/ledger at 600) sat in the tree undetected for exactly that reason: every unit test composes
 * synthetic capabilities, and no test had ever composed the real set.
 *
 * Composing the real set here is not possible — half the factories require config, and there is no
 * config to give them that would not be inventing one. So this reads the declared constants out of the
 * source text instead. No module loading, no config, no runtime: just the numbers as an author wrote them.
 *
 * It used to say `@pithy-sh/multiplayer` imports `cloudflare:workers` as well, and that is no longer
 * true of any capability — `capabilities/configEntrypoints.test.ts` imports every one of them in a node
 * process and fails the build if a runtime-only import comes back (#172). The config reason is the one
 * that still stands on its own.
 *
 * The table below is hand-maintained, and the first test is what keeps it honest: a new capability
 * that declares an order without registering it here fails, with a message saying so. That makes the
 * maintenance burden enforced rather than hoped for.
 */

/**
 * **Picking an order for a new capability.** Take {@link NEXT_FREE_ORDER}, declare it as
 * `<NAME>_MIGRATION_ORDER` in the capability's `capability.ts`, add a row to {@link DECLARED} below,
 * and bump `NEXT_FREE_ORDER` by 100. That is the whole procedure.
 *
 * Spacing is 100, which leaves room to slot a capability between two others — though you almost never
 * need to. **Order across capabilities is arbitrary.** No capability's tables reference another's: the
 * single foreign key in the repo is storage-internal (`pithy_storage_shares` → `pithy_storage_objects`),
 * and `@pithy-sh/auth`'s migration states outright that foreign keys are omitted because D1 does not
 * enforce them. So an order needs only two properties — unique within its database, and **stable
 * forever**. Renumbering a released capability renames its composed keys (`0350_media_0001_hashes`),
 * which makes Kysely treat applied migrations as unapplied and re-run them.
 *
 * There is no shortage of numbers. The ceiling is 9999 per database and the `app` database currently
 * reaches 1200, so ~87 more capabilities fit at this spacing. Both collisions this test exists to
 * prevent happened in a space that was 99% empty — the failure was uncoordinated allocation, not
 * capacity, which is why the procedure above routes every author through one file.
 */
const NEXT_FREE_ORDER = 1400;

/** Every declared migration order, and the database it sorts within. */
const DECLARED: ReadonlyArray<{ constant: string; database: string }> = [
  { constant: "EMAIL_MIGRATION_ORDER", database: "app" },
  { constant: "AUDIT_MIGRATION_ORDER", database: "app" },
  { constant: "AUTH_MIGRATION_ORDER", database: "app" },
  { constant: "MEDIA_MIGRATION_ORDER", database: "app" },
  { constant: "LEADERBOARD_MIGRATION_ORDER", database: "app" },
  { constant: "MULTIPLAYER_MIGRATION_ORDER", database: "app" },
  { constant: "RATING_MIGRATION_ORDER", database: "app" },
  { constant: "LEDGER_MIGRATION_ORDER", database: "app" },
  { constant: "MATCHMAKING_MIGRATION_ORDER", database: "app" },
  { constant: "STORAGE_MIGRATION_ORDER", database: "app" },
  { constant: "VECTOR_MIGRATION_ORDER", database: "app" },
  { constant: "PAYMENTS_MIGRATION_ORDER", database: "app" },
  { constant: "TESTERS_MIGRATION_ORDER", database: "app" },
  // The `control-plane` seam. Ships inside `@pithy-sh/core` rather than its own package, because every
  // capability contributing admin routes imports its guard, and a capability may depend on a core seam
  // but never on a sibling package. So core declares an order like any other capability — see the
  // scanner below, which no longer skips it.
  { constant: "CONTROLPLANE_MIGRATION_ORDER", database: "app" },
  { constant: "SUPPORT_MIGRATION_ORDER", database: "app" },
  // Its own durable database, shared by every environment — so it does not compete with `app`.
  { constant: "EMAIL_SUPPRESSIONS_MIGRATION_ORDER", database: "emailSuppressions" },
  // The secrets manager's own database, likewise separate.
  { constant: "SECRETS_MIGRATION_ORDER", database: "secrets" },
];

/** `packages/` — this file lives at `packages/cli/src/migrations/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * `const X_MIGRATION_ORDER = 300`, exported or not — `@pithy-sh/secrets` keeps its module-private,
 * which is exactly why importing the constants would not have worked either.
 */
const ORDER_DECLARATION = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_MIGRATION_ORDER)\s*=\s*(\d+)\s*;/gm;

/**
 * Scan every package's source for declared orders — core included.
 *
 * Core used to be skipped here, on the reasoning that it owns the ceiling rather than an order. That
 * stopped being true when the `control-plane` seam landed inside it: core now ships a real migration
 * for `pithy_controlplane_connections` and therefore competes for a slot in the `app` database like
 * any other capability. Leaving the skip in place would have meant core's order was the one number in
 * the repo nothing checked for collision — precisely the uncoordinated allocation this file exists to
 * prevent.
 *
 * The traversal is `ci/sourceFiles.ts`, the one walk over this tree's own source. What used to be here was a
 * private copy with a bare `statSync`: an entry that vanished between the listing and the probe threw, and
 * the `try` around it swallowed the throw by skipping **the whole package** — so the scan under-reported in
 * silence and the failure surfaced as `DECLARED names a constant no capability declares any more`, which is
 * the wrong sentence entirely (#202). A file that is not there is not a file that breaks a rule.
 */
function scanDeclaredOrders(): Map<string, number> {
  const orders = new Map<string, number>();
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const file of sourcePaths(join(PACKAGES, pkg.name, "src"))) {
      const source = readSource(file);
      if (source === null) continue;
      for (const match of source.matchAll(ORDER_DECLARATION)) {
        const [, name, value] = match;
        if (name && value) orders.set(name, Number(value));
      }
    }
  }
  return orders;
}

describe("migration orders across every shipped capability", () => {
  const scanned = scanDeclaredOrders();

  test("every declared order is registered in this file", () => {
    const registered = new Set(DECLARED.map((entry) => entry.constant));
    const unregistered = [...scanned.keys()].filter((name) => !registered.has(name)).sort();
    expect(
      unregistered,
      "A capability declares a migration order that this test does not know about. Add it to DECLARED with the database it sorts within, so its uniqueness is checked.",
    ).toEqual([]);
  });

  test("every registered order actually exists in the tree", () => {
    // The inverse: a capability that was deleted or renamed leaves a stale row asserting nothing.
    const stale = DECLARED.filter((entry) => !scanned.has(entry.constant)).map((entry) => entry.constant);
    expect(stale, "DECLARED names a constant no capability declares any more. Remove the row.").toEqual([]);
  });

  test("orders are unique within each database", () => {
    // The invariant `createMigrationRegistry` enforces at compose time, checked here across the whole
    // repo rather than only across whatever one project happens to compose.
    const byDatabase = new Map<string, Map<number, string[]>>();
    for (const { constant, database } of DECLARED) {
      const order = scanned.get(constant);
      if (order === undefined) continue; // Reported by the test above.
      const slots = byDatabase.get(database) ?? new Map<number, string[]>();
      slots.set(order, [...(slots.get(order) ?? []), constant]);
      byDatabase.set(database, slots);
    }

    const collisions: string[] = [];
    for (const [database, slots] of byDatabase) {
      for (const [order, owners] of slots) {
        if (owners.length > 1) collisions.push(`${database} @ ${order}: ${owners.sort().join(", ")}`);
      }
    }
    expect(
      collisions.sort(),
      "Two capabilities claim the same migration order in one database. `pithy migrate` throws for any project composing both.",
    ).toEqual([]);
  });

  test("the advertised next free order is actually free", () => {
    // The doc comment above tells the next author which number to take. A comment that points at a
    // taken slot would hand them the exact collision this file exists to prevent, so it is checked
    // rather than trusted — the same reason the DECLARED table is checked against the tree.
    const taken = [...scanned.entries()].filter(([, order]) => order === NEXT_FREE_ORDER).map(([name]) => name);
    expect(taken, `NEXT_FREE_ORDER is ${NEXT_FREE_ORDER}, but that slot is claimed. Bump it.`).toEqual([]);
  });

  test("every order is within the range the registry can encode", () => {
    // The composed key zero-pads to four digits (`0350_media_0001_hashes`), so 9999 is the ceiling and
    // a negative or fractional order would produce a key that sorts wrongly rather than failing loudly.
    for (const [name, order] of scanned) {
      expect(Number.isInteger(order), `${name} must be an integer`).toBe(true);
      expect(order, `${name} is out of range`).toBeGreaterThanOrEqual(0);
      expect(order, `${name} is out of range`).toBeLessThanOrEqual(9999);
    }
  });
});
