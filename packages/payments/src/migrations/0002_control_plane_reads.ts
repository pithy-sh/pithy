// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The three indexes the control-plane reads were written for (#247).
 *
 * `0001` indexed the three questions the capability asked of itself: a buyer's own purchases
 * (`userId, purchasedAt`), the reconciliation sweep (`status, expiresAt`), and the pending-delivery
 * queue. None of them answers "the newest purchases across every account", which is what a management
 * read asks — and the purchases primary key is a **text UUID**, deliberately, so it is unique but not
 * monotonic and is no use as a sort.
 *
 * Without these, every page of a purchases pane sorts a customer's entire order history to return
 * twenty-five rows, and does it again for the next page. That is not a slow query so much as a defect we
 * would be shipping into other people's production databases, which is why the read comes with its
 * migration rather than with a note about it. `@pithy-sh/email` reached the same conclusion for the same
 * reason: `pithyEmailJobsCreatedIdx` exists for its send-log listing and nothing else.
 *
 * `down` drops all three, and is tested. Dropping an index is lossless — the rows are untouched — so a
 * rollback costs the reads their plan and nothing else.
 */
export const payments_0002_control_plane_reads: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
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

    // The entitlement listing: `GET {base}/admin/entitlements`. `createdAt` rather than `updatedAt`,
    // because the projection re-derives every affected row on every purchase write — ordering on
    // `updatedAt` would shuffle rows under a reader for reasons that have nothing to do with the grant.
    // The per-account read needs no index of its own: `UNIQUE (userId, entitlement)` already serves it.
    await db.schema
      .createIndex("pithyPaymentsEntitlementsCreatedIdx")
      .on("pithyPaymentsEntitlements")
      .columns(["createdAt", "id"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyPaymentsEntitlementsCreatedIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesTypePurchasedIdx").execute();
    await db.schema.dropIndex("pithyPaymentsPurchasesPurchasedIdx").execute();
  },
};
