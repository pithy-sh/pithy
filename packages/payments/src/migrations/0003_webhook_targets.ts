// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * What each webhook event changed, and the index its management read pages on (#830).
 *
 * **A new migration, because `0001` and `0002` are history.** Both have been running since they shipped, and
 * reshaping either would reshape a database somebody is already running.
 *
 * - `pithy_payments_webhook_events.projected_targets` — the purchase and subscription row ids an event changed
 *   when it finished, as JSON (`data/webhookEvent.ts`'s `PaymentsWebhookEventTargets`). Nullable, and null on
 *   every row that exists when this runs: those events finished before anything recorded what they touched,
 *   and no store is asked again to reconstruct it. Null is *unrecorded*; two empty lists is *changed nothing*.
 * - `pithy_payments_webhook_events_received_idx` on `(receivedAt, id)` — `GET {base}/admin/webhook-events`
 *   pages newest received first, keyset on the id like every listing here. The pending index `0001` made
 *   leads on `processedAt` and serves the repair passes, not a page of everything.
 */
export const payments_0003_webhook_targets: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.alterTable("pithyPaymentsWebhookEvents").addColumn("projectedTargets", "text").execute();
    await db.schema
      .createIndex("pithyPaymentsWebhookEventsReceivedIdx")
      .on("pithyPaymentsWebhookEvents")
      .columns(["receivedAt", "id"])
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropIndex("pithyPaymentsWebhookEventsReceivedIdx").execute();
    await db.schema.alterTable("pithyPaymentsWebhookEvents").dropColumn("projectedTargets").execute();
  },
};
