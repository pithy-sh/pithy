// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Allowances, meters and reported usage: four tables and one column.
 *
 * **A new migration, because `0001` is history.** Every payments chain has been running since 0.1.0, and
 * reshaping `0001` would reshape a database somebody is already running. So everything lands here, with a
 * tested `down`.
 *
 * - `pithy_payments_overrides` — one subject's override, `UNIQUE (subjectType, subjectId)`. Keyed on the
 *   subject rather than on an entitlement key, so it survives a tier change.
 * - `pithy_payments_meter_counters` — one subject's use of one kit meter in one period,
 *   `UNIQUE (subjectType, subjectId, meter, periodStart)`. The period is half the key, which is what makes a
 *   new period start at zero with nothing to reset it.
 * - `pithy_payments_usage_reports` — one reported period of one quantity-billed subscription,
 *   `UNIQUE (rail, providerSubscriptionId, period)`. The key is the idempotency: a replayed run finds the row.
 * - `pithy_payments_usage_runs` — one reporting pass, its tally kept, the way reconcile runs are.
 * - `pithy_payments_purchases.quantity` — how many were bought, as the store states it. Nullable, because
 *   rows written before this did not record one and no store is asked again to invent it.
 *
 * The subject kind is closed with a `CHECK` on every subject-bearing table, as `0001` closes it, and every
 * count a row holds is checked non-negative: a negative usage is a bug in the writer, never a fact.
 */
export const payments_0002_allowances: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyPaymentsPurchases").addColumn("quantity", "integer").execute();

    await db.schema
      .createTable("pithyPaymentsOverrides")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("subjectType", "text", (c) => c.notNull())
      .addColumn("subjectId", "text", (c) => c.notNull())
      .addColumn("unrestricted", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("quotas", "text", (c) => c.notNull())
      .addColumn("features", "text", (c) => c.notNull())
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("reason", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // One override per subject. The conflict target every write is checked against, and the reason a
      // tier change cannot take an override with it: nothing about a key is in it.
      .addUniqueConstraint("pithyPaymentsOverridesSubjectIdx", ["subjectType", "subjectId"])
      .addCheckConstraint("pithyPaymentsOverridesSubjectType", sql`subject_type in ('user', 'organization')`)
      .addCheckConstraint("pithyPaymentsOverridesUnrestricted", sql`unrestricted in (0, 1)`)
      .addCheckConstraint("pithyPaymentsOverridesVersion", sql`version >= 1`)
      .execute();

    // `GET {base}/admin/overrides`, newest change first, keyset-paged on the id like every listing here.
    await db.schema
      .createIndex("pithyPaymentsOverridesUpdatedIdx")
      .on("pithyPaymentsOverrides")
      .columns(["updatedAt", "id"])
      .execute();

    // `pithy doctor` names every unrestricted subject. The largest grant the kit has must never be a row
    // nobody can find, so the read that finds them is an index range rather than a scan.
    await db.schema
      .createIndex("pithyPaymentsOverridesUnrestrictedIdx")
      .on("pithyPaymentsOverrides")
      .columns(["unrestricted", "subjectType", "subjectId"])
      .execute();

    await db.schema
      .createTable("pithyPaymentsMeterCounters")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("subjectType", "text", (c) => c.notNull())
      .addColumn("subjectId", "text", (c) => c.notNull())
      .addColumn("meter", "text", (c) => c.notNull())
      .addColumn("periodStart", "integer", (c) => c.notNull())
      .addColumn("used", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // The upsert conflict target the conditional charge is written against. One row per period: the
      // charge and the limit check are one statement on it, so a concurrent burst is serialized by SQLite.
      .addUniqueConstraint("pithyPaymentsMeterCountersPeriodIdx", ["subjectType", "subjectId", "meter", "periodStart"])
      .addCheckConstraint("pithyPaymentsMeterCountersSubjectType", sql`subject_type in ('user', 'organization')`)
      .addCheckConstraint("pithyPaymentsMeterCountersUsed", sql`used >= 0`)
      .execute();

    await db.schema
      .createTable("pithyPaymentsUsageReports")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("rail", "text", (c) => c.notNull())
      .addColumn("providerSubscriptionId", "text", (c) => c.notNull())
      .addColumn("purchaseId", "text", (c) => c.notNull())
      .addColumn("productId", "text", (c) => c.notNull())
      .addColumn("subjectType", "text", (c) => c.notNull())
      .addColumn("subjectId", "text", (c) => c.notNull())
      .addColumn("cadence", "text", (c) => c.notNull())
      .addColumn("period", "text", (c) => c.notNull())
      .addColumn("quantity", "integer", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("sampledAt", "integer", (c) => c.notNull())
      .addColumn("reportedAt", "integer")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // The idempotency key: one row per period of one subscription on one store. Reporting a period twice
      // is a second insert against this, and it is refused.
      .addUniqueConstraint("pithyPaymentsUsageReportsPeriodIdx", ["rail", "providerSubscriptionId", "period"])
      .addCheckConstraint("pithyPaymentsUsageReportsSubjectType", sql`subject_type in ('user', 'organization')`)
      .addCheckConstraint("pithyPaymentsUsageReportsCadence", sql`cadence in ('period-end', 'daily-peak')`)
      .addCheckConstraint("pithyPaymentsUsageReportsStatus", sql`status in ('sampling', 'claimed', 'reported')`)
      .addCheckConstraint("pithyPaymentsUsageReportsQuantity", sql`quantity >= 0`)
      .execute();

    // The subscription reads' "last reported count" is a subscription's newest report, which the unique's
    // leading `(rail, providerSubscriptionId)` already answers as one index range — so no index of its own.

    await db.schema
      .createTable("pithyPaymentsUsageRuns")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("startedAt", "integer", (c) => c.notNull())
      .addColumn("finishedAt", "integer", (c) => c.notNull())
      .addColumn("scanned", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("reported", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("sampled", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("alreadyReported", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("skipped", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("invalid", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("failed", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("findings", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addCheckConstraint(
        "pithyPaymentsUsageRunsCounts",
        sql`scanned >= 0 and reported >= 0 and sampled >= 0 and already_reported >= 0 and skipped >= 0 and invalid >= 0 and failed >= 0`,
      )
      .execute();

    await db.schema
      .createIndex("pithyPaymentsUsageRunsStartedIdx")
      .on("pithyPaymentsUsageRuns")
      .columns(["startedAt", "id"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyPaymentsUsageRunsStartedIdx").execute();
    await db.schema.dropTable("pithyPaymentsUsageRuns").execute();
    await db.schema.dropTable("pithyPaymentsUsageReports").execute();
    await db.schema.dropTable("pithyPaymentsMeterCounters").execute();
    await db.schema.dropIndex("pithyPaymentsOverridesUnrestrictedIdx").execute();
    await db.schema.dropIndex("pithyPaymentsOverridesUpdatedIdx").execute();
    await db.schema.dropTable("pithyPaymentsOverrides").execute();
    await db.schema.alterTable("pithyPaymentsPurchases").dropColumn("quantity").execute();
  },
};
