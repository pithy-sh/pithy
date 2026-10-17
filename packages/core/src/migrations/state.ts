// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { MigrationProvider } from "kysely/migration";
import { appliedMigrationChain, migrationKysely } from "./bookkeeping";
import { readGroupPosition, readMigrationGroups } from "./groups";
import { readMigrationLedger } from "./runner";

/**
 * **Where one database stands, read in one place (#729).**
 *
 * The control-plane seam answers `GET {basePath}/migrations` from this: what is applied, what this build
 * declares and the database lacks, what the database holds and this build no longer declares, and which
 * run put it there. Each half already had a reader — {@link readMigrationLedger} for both directions,
 * {@link readMigrationGroups} and {@link readGroupPosition} for the group (#694) — and this composes them
 * rather than reading either table a second way.
 *
 * Read-only. It applies nothing, creates nothing, and reverses nothing: a screen somebody opened to *ask*
 * must not be the thing that changes the schema.
 */

/** Whether the last group can still be taken back by name — {@link readGroupPosition}, minus `absent`. */
export type MigrationGroupStanding =
  | {
      /** The group's migrations are the contiguous tip of this ledger. The CLI's rollback has refusals of its own. */
      state: "top";
    }
  | {
      /** Something sits over the group or inside it, so reversing it by name is refused. */
      state: "buried";
      /** The groups in the way, newest first. */
      above: string[];
      /** The migrations in the way that no group claims, newest first. */
      ungrouped: string[];
    };

/** The newest group with anything still applied here, and whether it is still reversible. */
export interface MigrationLastGroup {
  /** The group's value — what `--rollback --group` takes. */
  group: string;
  /** When it last applied something here. */
  appliedAt: Date;
  /** What it applied here and is still applied, in application order. */
  migrations: string[];
  /** Whether it is the tip of the chain, or what is in its way. */
  position: MigrationGroupStanding;
}

/** One database's migration state. */
export interface MigrationState {
  /** Every applied migration, in the order the ledger applied them. */
  applied: string[];
  /** Declared and not yet applied, in the order they would run. */
  pending: string[];
  /** Applied and not declared by this build, sorted. Kysely refuses the whole chain on any one of these. */
  undeclared: string[];
  /** The newest group with anything applied here, or null when nothing applied here was ever grouped. */
  lastGroup: MigrationLastGroup | null;
}

/**
 * Read one database's migration state against the provider this build composes for it.
 *
 * **The last group is the newest one with something still applied.** Group rows are forgotten as their
 * migrations come down, so this is ordinarily the newest group recorded. A group whose rows outlived their
 * ledger rows reads as `absent` and is passed over: naming it as where the environment stands would name a
 * release that is no longer in the database.
 */
export async function readMigrationState(database: D1Database, provider: MigrationProvider): Promise<MigrationState> {
  const { pending, undeclared } = await readMigrationLedger(database, provider);
  const applied = await appliedMigrationChain(migrationKysely(database));
  return { applied, pending, undeclared, lastGroup: await lastGroupOf(database, applied) };
}

/** Walk the groups newest first and stop at the first one this database still holds any of. */
async function lastGroupOf(database: D1Database, applied: readonly string[]): Promise<MigrationLastGroup | null> {
  const held = new Set(applied);
  const groups = await readMigrationGroups(database);
  for (const group of [...groups].reverse()) {
    const position = await readGroupPosition(database, group.group);
    if (position.state === "absent") continue;
    return {
      group: group.group,
      appliedAt: group.appliedAt,
      migrations: group.migrations.filter((name) => held.has(name)),
      position:
        position.state === "top"
          ? { state: "top" }
          : { state: "buried", above: position.above, ungrouped: position.ungrouped },
    };
  }
  return null;
}
