// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Payments' six tables: the purchase projection, the materialized entitlement read model, the
 * provider-identity map, the raw webhook log, the reconciliation run log, and the sync cursors.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * Two constraints carry the design. `UNIQUE (rail, providerTransactionId)` on purchases is what makes
 * three write paths converge on one row — a replayed webhook violates it and the write becomes a
 * no-op update rather than a second purchase. `UNIQUE (userId, entitlement)` on entitlements is what
 * makes the read model a read model: one row per user per entitlement, whichever purchase currently
 * grants it. Correctness lives in the schema, not in a hopeful application-level check a race could skip.
 *
 * The indexes come in two families. Three serve the questions the capability asks of itself — a buyer's
 * own purchases, the reconciliation sweep, the pending-delivery queue. Three serve the control-plane
 * reads (#247), which ask a different question: the newest rows across every account. The purchases
 * primary key is a **text UUID**, deliberately, so it is unique but not monotonic and is no use as a
 * sort; without those three, every page of a purchases pane sorts a customer's entire order history to
 * return twenty-five rows, and does it again for the next page. That is not a slow query so much as a
 * defect shipped into other people's production databases, which is why the reads' indexes are part of
 * the schema rather than a note about it.
 *
 * This is the whole payments schema, in one migration — see `CONTRIBUTING.md` §Migrations for why that
 * is the shape while nothing is published, and what changes the day something is.
 */
export const payments_0001_purchases: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyPaymentsPurchases")
      // Text UUID: these surface in API responses, and sequential ids would leak order volume.
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("rail", "text", (c) => c.notNull())
      .addColumn("providerTransactionId", "text", (c) => c.notNull())
      .addColumn("productId", "text", (c) => c.notNull())
      .addColumn("providerProductId", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      // Defaulted in SQL as well as in the Zod object: three of the four rails never mention it, and a
      // row written by one of them must not depend on the writer remembering to set it.
      .addColumn("role", "text", (c) => c.notNull().defaultTo("charge"))
      .addColumn("environment", "text", (c) => c.notNull())
      .addColumn("purchasedAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer")
      .addColumn("revokedAt", "integer")
      // When a paused subscription resumes, as the provider stated it. Nullable, because "paused
      // indefinitely" is a real state on every rail that pauses at all — see `data/pause.ts`.
      .addColumn("resumesAt", "integer")
      .addColumn("originalTransactionId", "text")
      .addColumn("amountMinor", "integer")
      .addColumn("currency", "text")
      .addColumn("providerEventAt", "integer", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // The idempotency guard all three write paths rely on. A replay's insert violates it, which routes
      // the write into its `ON CONFLICT` branch, so one provider transaction is one row forever.
      .addUniqueConstraint("pithyPaymentsPurchasesProviderIdx", ["rail", "providerTransactionId"])
      // A sandbox transaction must never grant a production entitlement, so the value is constrained at
      // the database rather than trusted from a provider payload.
      .addCheckConstraint("pithyPaymentsPurchasesEnvironment", sql`environment in ('production', 'sandbox')`)
      // Amounts are integer minor units, never floats, and never negative.
      .addCheckConstraint("pithyPaymentsPurchasesAmount", sql`amount_minor is null or amount_minor >= 0`)
      // A `state` row never fulfills a `grants` clause, so a typo here would credit a ledger for a
      // subscription's standing. Constrained at the database for the same reason `environment` is.
      .addCheckConstraint("pithyPaymentsPurchasesRole", sql`role in ('charge', 'state')`)
      // A resume date only means anything on a paused row. Constrained at the database because it is what
      // makes the column's null readable: on a paused row null is the provider saying "indefinitely", and
      // everywhere else it is "not paused" — two facts a consumer has to tell apart, and a rail that wrote
      // a renewal date or a period end into it would silently collapse them.
      .addCheckConstraint("pithyPaymentsPurchasesResumes", sql`resumes_at is null or status = 'paused'`)
      .execute();

    // The owner read: a user's purchases, newest first.
    await db.schema
      .createIndex("pithyPaymentsPurchasesOwnerIdx")
      .on("pithyPaymentsPurchases")
      .columns(["userId", "purchasedAt"])
      .execute();

    // The reconciliation read: subscriptions near expiry, oldest verification first.
    await db.schema
      .createIndex("pithyPaymentsPurchasesExpiryIdx")
      .on("pithyPaymentsPurchases")
      .columns(["status", "expiresAt"])
      .execute();

    // The purchase log, newest first: `GET {base}/admin/purchases`. The keyset resumes on
    // `(purchasedAt, id)`, and `purchasedAt` leading is what makes the page a range scan the LIMIT can
    // genuinely stop.
    await db.schema
      .createIndex("pithyPaymentsPurchasesPurchasedIdx")
      .on("pithyPaymentsPurchases")
      .columns(["purchasedAt", "id"])
      .execute();

    // The subscriptions listing: `GET {base}/admin/subscriptions`. `type` is an equality and
    // `purchasedAt` is the ordering column, so the filtered page is a range scan of its own rather than a
    // scan of the whole log looking for the rows that renew. A project selling mostly consumables is
    // exactly the one where the difference is large.
    await db.schema
      .createIndex("pithyPaymentsPurchasesTypePurchasedIdx")
      .on("pithyPaymentsPurchases")
      .columns(["type", "purchasedAt", "id"])
      .execute();

    await db.schema
      .createTable("pithyPaymentsEntitlements")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("entitlement", "text", (c) => c.notNull())
      .addColumn("active", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("expiresAt", "integer")
      .addColumn("sourcePurchaseId", "text")
      // A human's decision, held against the projection. Every other row here is derived from the purchases
      // table on every write that touches its key, which is what keeps the read model honest — and what would
      // otherwise erase a support comp the moment the user's next renewal arrived.
      .addColumn("manual", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // One row per user per entitlement — the upsert conflict target that makes this a read model.
      .addUniqueConstraint("pithyPaymentsEntitlementsOwnerIdx", ["userId", "entitlement"])
      .addCheckConstraint("pithyPaymentsEntitlementsActive", sql`active in (0, 1)`)
      .addCheckConstraint("pithyPaymentsEntitlementsManual", sql`manual in (0, 1)`)
      .execute();

    // The entitlement listing: `GET {base}/admin/entitlements`. `createdAt` rather than `updatedAt`,
    // because the projection re-derives every affected row on every purchase write — ordering on
    // `updatedAt` would shuffle rows under a reader for reasons that have nothing to do with the grant.
    // The per-account read needs no index of its own: `UNIQUE (userId, entitlement)` already serves it.
    await db.schema
      .createIndex("pithyPaymentsEntitlementsCreatedIdx")
      .on("pithyPaymentsEntitlements")
      .columns(["createdAt", "id"])
      .execute();

    await db.schema
      .createTable("pithyPaymentsProviderAccounts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("rail", "text", (c) => c.notNull())
      .addColumn("providerAccountId", "text", (c) => c.notNull())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // A webhook arrives carrying `cus_123`, not a Pithy user id. This is the only mapping back, so it
      // must be one-to-one per rail.
      .addUniqueConstraint("pithyPaymentsProviderAccountsIdx", ["rail", "providerAccountId"])
      .execute();

    await db.schema
      .createTable("pithyPaymentsWebhookEvents")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("rail", "text", (c) => c.notNull())
      .addColumn("providerEventId", "text", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("receivedAt", "integer", (c) => c.notNull())
      // When this delivery was **finished with** — projected, or deliberately nothing to project. The one
      // column the webhook guard short-circuits on, so it says "we have finished this" and never "we have
      // seen this". Three writers once disagreed about that and two of them stopped purchases from ever
      // being projected (#337).
      .addColumn("processedAt", "integer")
      // When a repair pass gave up on this event so its stream could advance.
      //
      // **A second timestamp rather than a status column, and beside `processedAt` rather than replacing
      // it.** Abandoning is the sweep's decision about its own progress; finishing is a fact about the
      // purchase. Collapsing them into one column is what #337 was. A `status` enum would have made the
      // writers exhaustive and left every reader free to spell out its own predicate — which is where the
      // defect actually lived — so the state is derived in `data/webhookEvent.ts` and asked for by name,
      // and the storage stays timestamps: they answer *when*, which is what this table is read for, and
      // they cannot contradict each other the way an enum can contradict the timestamp beside it.
      .addColumn("abandonedAt", "integer")
      .addColumn("error", "text")
      // How many times a repair pass has tried this event and failed.
      //
      // **Here rather than in a table of its own, because the count is a fact about this row's handling.**
      // `processedAt` and `error` are already the other two, and the three are only ever read together:
      // "it arrived, it was tried N times, here is why it still has not gone through". A side table would
      // add a second row per event, a join for the one question anybody asks, and a way for the two to
      // disagree about an event that exists in one and not the other. KV would add a second store with no
      // transactional relationship to the row it counts. The count also has to survive exactly as long as
      // the row does and no longer, which is what a column gets for free and every alternative has to
      // arrange.
      //
      // Defaulted, so the webhook path — which does not retry and does not count — inserts as it always
      // did.
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // Every provider delivers at-least-once and retries, so a redelivery is expected and must be
      // recognized rather than reprocessed.
      .addUniqueConstraint("pithyPaymentsWebhookEventsIdx", ["rail", "providerEventId"])
      .execute();

    // The "why didn't this renew" read: everything not yet finished with, oldest first — pending, failed,
    // and abandoned alike, because all three are deliveries whose purchase has not been projected. That
    // an abandoned event appears here is deliberate: it is exactly the row an operator has to be able to
    // find, and `abandonedAt` beside it says which of the three it is.
    await db.schema
      .createIndex("pithyPaymentsWebhookEventsPendingIdx")
      .on("pithyPaymentsWebhookEvents")
      .columns(["processedAt", "receivedAt"])
      .execute();

    // One row per reconciliation pass. Counts, timestamps and enums — there is deliberately no column a
    // provider payload could be written into, which is a stronger control than never selecting one.
    await db.schema
      .createTable("pithyPaymentsReconcileRuns")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("startedAt", "integer", (c) => c.notNull())
      .addColumn("finishedAt", "integer", (c) => c.notNull())
      .addColumn("environment", "text", (c) => c.notNull())
      // Null is the scheduled behaviour — every enabled rail. A value means somebody narrowed the pass.
      .addColumn("rail", "text")
      .addColumn("pages", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("scanned", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("unchanged", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("drifted", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("superseded", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("skipped", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("failed", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("truncated", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("dryRun", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // Same rule the purchases table states: a sandbox pass and a production pass are facts about
      // different money, and the database is where that is constrained rather than trusted.
      .addCheckConstraint("pithyPaymentsReconcileRunsEnvironment", sql`environment in ('production', 'sandbox')`)
      .addCheckConstraint("pithyPaymentsReconcileRunsTruncated", sql`truncated in (0, 1)`)
      .addCheckConstraint("pithyPaymentsReconcileRunsDryRun", sql`dry_run in (0, 1)`)
      // A tally cannot be negative, and a run that reported one is a bug in the pass rather than a fact.
      .addCheckConstraint(
        "pithyPaymentsReconcileRunsCounts",
        sql`pages >= 0 and scanned >= 0 and unchanged >= 0 and drifted >= 0 and superseded >= 0 and skipped >= 0 and failed >= 0`,
      )
      .execute();

    // The runs listing: `GET {base}/admin/reconcile-runs`, newest first, and the retention prune's own
    // range delete. Both read `startedAt` leading; the id is the keyset tiebreak, as everywhere else here.
    await db.schema
      .createIndex("pithyPaymentsReconcileRunsStartedIdx")
      .on("pithyPaymentsReconcileRuns")
      .columns(["startedAt", "id"])
      .execute();

    // Where a resumable sweep left off. One row per `(rail, name)`, because a rail may sweep more than
    // one stream and a name is what tells them apart.
    //
    // This is **not** a copy of a provider's data and is not a cache of one: it is a single opaque
    // pointer into somebody else's stream, which is the minimum state a resumable read can have. The
    // alternative to storing it is re-reading ninety days of events on every run.
    await db.schema
      .createTable("pithyPaymentsSyncCursors")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("rail", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      // The provider's own resume token — Paddle's `evt_…`. Nullable, because a cursor that has never
      // advanced is a real state: it means "start at the oldest event this provider still retains".
      .addColumn("cursor", "text")
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // One cursor per stream. Two rows for one stream would let two runs each believe they were
      // authoritative, and the sweep would silently skip whatever fell between them.
      .addUniqueConstraint("pithyPaymentsSyncCursorsIdx", ["rail", "name"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyPaymentsSyncCursors").execute();
    await db.schema.dropIndex("pithyPaymentsReconcileRunsStartedIdx").execute();
    await db.schema.dropTable("pithyPaymentsReconcileRuns").execute();
    await db.schema.dropIndex("pithyPaymentsWebhookEventsPendingIdx").execute();
    await db.schema.dropTable("pithyPaymentsWebhookEvents").execute();
    await db.schema.dropTable("pithyPaymentsProviderAccounts").execute();
    await db.schema.dropIndex("pithyPaymentsEntitlementsCreatedIdx").execute();
    await db.schema.dropTable("pithyPaymentsEntitlements").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesTypePurchasedIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesPurchasedIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesExpiryIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesOwnerIdx").execute();
    await db.schema.dropTable("pithyPaymentsPurchases").execute();
  },
};
