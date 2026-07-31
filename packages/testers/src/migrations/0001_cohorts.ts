// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The four testers tables: the cohort, its roster, the append-only event log the roster is replayed
 * from, and the daily snapshot the trend chart is drawn from.
 *
 * Identifiers are camelCase throughout — `CamelCasePlugin` snake-cases the DDL. Dates are `integer`
 * ms-epoch, booleans are `integer` 0/1, JSON columns are `text`.
 *
 * **Shape and value rules live in the Zod schemas, not here.** One Zod object per table is the entire
 * table definition (CLAUDE.md §Data layer), so an enum's members, a number's bounds, a boolean's 0/1
 * and the one cross-field rule (`maxRosterSize >= targetSize`) are all declared and enforced there —
 * on `parse` *and* on `encode`, which is the boundary every write already crosses. Restating them as
 * `CHECK` constraints bought a second source of truth that could drift from the first, and produced a
 * raw `CHECK constraint failed` out of Kysely instead of a `PithyError` with an action line — no help
 * to a human and no `--json` error object for an agent.
 *
 * What stays is what Zod cannot express, because it is a fact about the table rather than about a row:
 * `UNIQUE` (a cohort name, a member's address within a cohort, a token, one snapshot per cohort-day)
 * and the indexes the queries actually use.
 *
 * No foreign keys, matching the rest of the repo: D1 does not enforce them, so declaring them would be
 * documentation pretending to be a constraint. Referential integrity is held by the writers, and cohort
 * teardown deletes children first.
 */
export const testers_0001_cohorts: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyTestersCohorts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("targetPlatform", "text", (c) => c.notNull())
      .addColumn("targetSize", "integer", (c) => c.notNull())
      .addColumn("windowDays", "integer", (c) => c.notNull())
      .addColumn("maxRosterSize", "integer", (c) => c.notNull())
      .addColumn("storeOptInUrl", "text")
      .addColumn("resetPolicy", "text", (c) => c.notNull())
      .addColumn("closedAt", "integer")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .addUniqueConstraint("pithyTestersCohortsNameIdx", ["name"])
      .execute();

    await db.schema
      .createTable("pithyTestersMembers")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("cohortId", "text", (c) => c.notNull())
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("name", "text")
      .addColumn("optInToken", "text", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("invitedAt", "integer", (c) => c.notNull())
      .addColumn("acceptedAt", "integer")
      .addColumn("optedInAt", "integer")
      .addColumn("lapsedAt", "integer")
      .addColumn("lastInvitedAt", "integer", (c) => c.notNull())
      .addColumn("lastNudgedAt", "integer")
      .addColumn("nudgeCount", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("unreachable", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // One address per cohort. This is what makes an invitation idempotent at the storage layer rather
      // than only in the handler: two concurrent invites of the same person cannot both land and split
      // one tester's history across two rows, which would double-count them toward the target.
      .addUniqueConstraint("pithyTestersMembersCohortEmailIdx", ["cohortId", "email"])
      // The confirmation token is the whole credential, so it is unique across every cohort rather than
      // within one: a collision would let one tester's link confirm another's opt-in.
      .addUniqueConstraint("pithyTestersMembersOptInTokenIdx", ["optInToken"])
      .execute();

    // The roster read: every live member of one cohort, ordered by state. Covers the common
    // "who is on this cohort" query without touching the event log.
    await db.schema
      .createIndex("pithyTestersMembersCohortStateIdx")
      .on("pithyTestersMembers")
      .columns(["cohortId", "state"])
      .execute();

    // The activity reader resolves testers by address across every cohort at once, so the daily pass
    // does one lookup per distinct address rather than one per membership.
    await db.schema.createIndex("pithyTestersMembersEmailIdx").on("pithyTestersMembers").column("email").execute();

    await db.schema
      .createTable("pithyTestersEvents")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("cohortId", "text", (c) => c.notNull())
      .addColumn("memberId", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("actor", "text", (c) => c.notNull())
      .addColumn("occurredAt", "integer", (c) => c.notNull())
      .addColumn("metadata", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // The cohort-wide replay: every event for one cohort in `occurredAt` order. Ordering on the index
    // rather than in memory matters because the replay walks the whole history to rebuild the streak.
    await db.schema
      .createIndex("pithyTestersEventsCohortTimeIdx")
      .on("pithyTestersEvents")
      .columns(["cohortId", "occurredAt"])
      .execute();

    // The per-tester replay, and the nudge-history read the cooldown and the health score both use.
    await db.schema
      .createIndex("pithyTestersEventsMemberTimeIdx")
      .on("pithyTestersEvents")
      .columns(["memberId", "occurredAt"])
      .execute();

    await db.schema
      .createTable("pithyTestersCohortSnapshots")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("cohortId", "text", (c) => c.notNull())
      .addColumn("snapshotOn", "text", (c) => c.notNull())
      .addColumn("dayIndex", "integer", (c) => c.notNull())
      .addColumn("computedAt", "integer", (c) => c.notNull())
      .addColumn("backfilled", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("modelVersion", "text", (c) => c.notNull())
      .addColumn("rosterSize", "integer", (c) => c.notNull())
      .addColumn("invitedCount", "integer", (c) => c.notNull())
      .addColumn("acceptedCount", "integer", (c) => c.notNull())
      .addColumn("estimatedOptedInCount", "integer", (c) => c.notNull())
      .addColumn("lapsedCount", "integer", (c) => c.notNull())
      .addColumn("unreachableCount", "integer", (c) => c.notNull())
      .addColumn("targetSize", "integer", (c) => c.notNull())
      .addColumn("windowDays", "integer", (c) => c.notNull())
      .addColumn("meetsTarget", "integer", (c) => c.notNull())
      .addColumn("headroom", "integer", (c) => c.notNull())
      .addColumn("estimatedHeldDays", "integer", (c) => c.notNull())
      .addColumn("estimatedWindowStartOn", "text")
      .addColumn("estimatedDaysRemaining", "integer", (c) => c.notNull())
      .addColumn("resetCount", "integer", (c) => c.notNull())
      .addColumn("resetToday", "integer", (c) => c.notNull())
      .addColumn("observedCount", "integer", (c) => c.notNull())
      .addColumn("neverLinkedCount", "integer", (c) => c.notNull())
      .addColumn("observedCoverage", "real", (c) => c.notNull())
      .addColumn("activeCount", "integer", (c) => c.notNull())
      .addColumn("darkThreeToSevenCount", "integer", (c) => c.notNull())
      .addColumn("darkEightToThirteenCount", "integer", (c) => c.notNull())
      .addColumn("darkFourteenPlusCount", "integer", (c) => c.notNull())
      .addColumn("sessionsInWindow", "integer", (c) => c.notNull())
      .addColumn("targetPlatformDeviceCount", "integer", (c) => c.notNull())
      .addColumn("healthyCount", "integer", (c) => c.notNull())
      .addColumn("watchCount", "integer", (c) => c.notNull())
      .addColumn("atRiskCount", "integer", (c) => c.notNull())
      .addColumn("criticalCount", "integer", (c) => c.notNull())
      .addColumn("unknownHealthCount", "integer", (c) => c.notNull())
      .addColumn("medianHealth", "integer")
      .addColumn("minHealth", "integer")
      .addColumn("expectedSurvivors", "real", (c) => c.notNull())
      .addColumn("probabilityReachTarget", "real", (c) => c.notNull())
      .addColumn("probabilityHoldWindow", "real")
      .addColumn("successProbability", "real")
      .addColumn("successProbabilityLow", "real")
      .addColumn("successProbabilityHigh", "real")
      .addColumn("confidence", "text")
      .addColumn("basis", "text", (c) => c.notNull())
      .addColumn("projectedTargetMetOn", "text")
      .addColumn("projectedCompleteOn", "text")
      .addColumn("invitesNeeded", "integer", (c) => c.notNull())
      .addColumn("recommendedRosterSize", "integer", (c) => c.notNull())
      .addColumn("optedInDelta1d", "integer")
      .addColumn("optedInDelta7d", "integer")
      .addColumn("activeDelta7d", "integer")
      .addColumn("successProbabilityDelta1d", "real")
      .addColumn("successProbabilityDelta7d", "real")
      .addColumn("trendDirection", "text", (c) => c.notNull())
      .addColumn("fragile", "integer", (c) => c.notNull())
      .addColumn("trendReason", "text", (c) => c.notNull())
      .addColumn("nudgesSent", "text", (c) => c.notNull())
      .addColumn("bouncedCount", "integer", (c) => c.notNull())
      // One row per cohort per UTC day. This is what makes the daily pass idempotent: a re-run — a
      // retried Workflow step, a manual backfill, two crons firing on a leap second — upserts the day
      // rather than appending a second version of it, so a replay can never bend the chart.
      .addUniqueConstraint("pithyTestersSnapshotsCohortDayIdx", ["cohortId", "snapshotOn"])
      .execute();

    // The trailing-series read: the last N days of one cohort, newest first. The summary card reads one
    // row from the head of this index, which is what keeps the default response cheap.
    await db.schema
      .createIndex("pithyTestersSnapshotsCohortRecentIdx")
      .on("pithyTestersCohortSnapshots")
      .columns(["cohortId", "snapshotOn"])
      .execute();
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyTestersSnapshotsCohortRecentIdx").execute();
    await db.schema.dropTable("pithyTestersCohortSnapshots").execute();
    await db.schema.dropIndex("pithyTestersEventsMemberTimeIdx").execute();
    await db.schema.dropIndex("pithyTestersEventsCohortTimeIdx").execute();
    await db.schema.dropTable("pithyTestersEvents").execute();
    await db.schema.dropIndex("pithyTestersMembersEmailIdx").execute();
    await db.schema.dropIndex("pithyTestersMembersCohortStateIdx").execute();
    await db.schema.dropTable("pithyTestersMembers").execute();
    await db.schema.dropTable("pithyTestersCohorts").execute();
  },
};
