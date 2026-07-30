// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * Payments' four tables: the purchase projection, the materialized entitlement read model, the
 * provider-identity map, and the raw webhook log.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * Two constraints carry the design. `UNIQUE (rail, providerTransactionId)` on purchases is what makes
 * three write paths converge on one row — a replayed webhook violates it and the write becomes a
 * no-op update rather than a second purchase. `UNIQUE (userId, entitlement)` on entitlements is what
 * makes the read model a read model: one row per user per entitlement, whichever purchase currently
 * grants it. Correctness lives in the schema, not in a hopeful application-level check a race could skip.
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
      .addColumn("environment", "text", (c) => c.notNull())
      .addColumn("purchasedAt", "integer", (c) => c.notNull())
      .addColumn("expiresAt", "integer")
      .addColumn("revokedAt", "integer")
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
      .addColumn("processedAt", "integer")
      .addColumn("error", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      // All three providers deliver at-least-once and retry, so a redelivery is expected and must be
      // recognized rather than reprocessed.
      .addUniqueConstraint("pithyPaymentsWebhookEventsIdx", ["rail", "providerEventId"])
      .execute();

    // The "why didn't this renew" read: unprocessed or errored deliveries, oldest first.
    await db.schema
      .createIndex("pithyPaymentsWebhookEventsPendingIdx")
      .on("pithyPaymentsWebhookEvents")
      .columns(["processedAt", "receivedAt"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyPaymentsWebhookEventsPendingIdx").execute();
    await db.schema.dropTable("pithyPaymentsWebhookEvents").execute();
    await db.schema.dropTable("pithyPaymentsProviderAccounts").execute();
    await db.schema.dropTable("pithyPaymentsEntitlements").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesExpiryIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesOwnerIdx").execute();
    await db.schema.dropTable("pithyPaymentsPurchases").execute();
  },
};
