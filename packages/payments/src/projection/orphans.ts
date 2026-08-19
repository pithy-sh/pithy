// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import type { PaymentsConfig } from "../config/config";
import type { PurchaseEnvironment } from "../data/purchase";
import type { PaymentsRail } from "../data/rail";
import { PAYMENTS_WEBHOOK_EVENTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsWebhookEvent, WEBHOOK_EVENT_ORPHANED, webhookEventAwaitsOwner } from "../data/webhookEvent";
import type { VerifiedNotification } from "../rails/contract";
import { resolveNotificationOwner } from "./owner";
import { type PurchaseProjection, projectPurchase } from "./writer";

/**
 * The repair that runs when an account links: project the purchases that were waiting for exactly that.
 *
 * ## The gap this closes (#341)
 *
 * An orphan is an authentic notification carrying a real purchase and nothing that says whose it is. Both
 * paths that meet one leave the row unfinished on purpose — the webhook handler records the reason and
 * withholds `processedAt`, the sweep stamps `abandonedAt` so its stream can advance — and both then rely on
 * **a later delivery of the same event** to repair it. That is the right bet when the store redelivers. It
 * is no bet at all when the only future event is the account linking: nothing redelivers on that signal,
 * every store's retry window closes within days, and the sweep's cursor is long past.
 *
 * Reproduced on real D1 before this existed: sweep an unstamped `subscription.activated` for an unlinked
 * customer, link the account, sweep ten more times. The purchase is never projected. Not once, ever — the
 * orphan gets exactly one owner resolution in its life, at the moment nobody could answer it.
 *
 * ## Why here and not in the sweep
 *
 * The two halves of the question live in different places. The link path knows *which* customer just became
 * resolvable; the sweep knows *which events* are outstanding. One of them has to ask the other, and asking
 * from the link side is the cheaper direction by a wide margin: it runs once per link rather than once per
 * sweep, the set it looks at is bounded by {@link ORPHAN_REPAIR_LIMIT}, and — decisively — it works on the
 * four rails that have no sweep at all. A rail without a repair pass is exactly where a lost orphan stays
 * lost.
 *
 * ## Which rows, and why not simply "unfinished"
 *
 * {@link webhookEventAwaitsOwner}: unfinished, and carrying the {@link WEBHOOK_EVENT_ORPHANED} marker. An
 * account linking repairs one thing — a missing owner. A quarantined event, a failed projection, an unmapped
 * SKU are all unfinished too, and re-running them on this signal would be an unbounded retry loop triggered
 * by unrelated traffic. The marker is what makes the set the *right* set rather than merely a small one.
 *
 * ## Why a payload replay rather than a stored event
 *
 * The row already holds the notification whole — that is what `payload` is for, and the reason it is stored
 * rather than summarized. So the purchase is recoverable without a second column, a migration, or a shape
 * that could disagree with the payload it was derived from. What it costs is a rail able to re-read its own
 * recorded body, which is {@link PaymentsRailProvider.replay} and is optional for the two rails whose stored
 * body is a signed blob.
 *
 * ## What it deliberately does not do
 *
 * It never *invents* an owner. Every row goes back through {@link resolveNotificationOwner}, against the same
 * table in the same trust order, so a link that resolves nothing changes nothing — and a row for a different
 * holder that happens to be in the same page is left exactly as it stood. Passing the freshly linked subject
 * straight to the writer would be the shortcut, and it would project one customer's purchase onto another's
 * account the first time two orphans shared a page.
 *
 * **Per row, and both halves per row.** The subject is resolved inside the loop, from the row's own hints, so
 * a page of orphans is a page of independent questions rather than one answer applied to all of them. There
 * is no subject computed before the loop for the same reason there is no `subjectType` taken from config: a
 * kind that outlived the row it came from is how an organization's purchase lands on a user with the same id.
 */

/**
 * How many orphaned rows one link may repair.
 *
 * A bound rather than "all of them", because this runs inside a webhook handler that a store is timing. A
 * link arriving after a long outage could face hundreds of orphans, and a handler that walks them all is a
 * handler the store times out and redelivers — which produces the same walk again, from the top.
 *
 * Small enough to be invisible in a request, and the leftovers are not lost: they still carry the marker, and
 * the next link on that rail takes the next page. The rows are taken oldest first so the queue drains in
 * order rather than starving its own tail.
 */
export const ORPHAN_REPAIR_LIMIT = 25;

/** What the repair needs to project what it finds: the catalog, the environment it is writing for, the clock. */
export interface RepairOrphansOptions {
  /** The resolved catalog, handed to the writer unchanged. */
  config: PaymentsConfig;
  /** This deployment's store environment. The writer refuses a row that disagrees. */
  environment: PurchaseEnvironment;
  /** The clock. */
  now: Date;
  /**
   * Re-read one recorded payload — {@link PaymentsRailProvider.replay}, bound to its rail.
   *
   * Passed in rather than resolved here because building a rail provider needs credentials, and this module
   * has no business reading a secret. A caller whose rail cannot replay passes nothing and the repair is a
   * no-op, which is the honest answer for it.
   */
  replay?: (payload: Record<string, unknown>) => Promise<VerifiedNotification | undefined>;
  /** What to do with each repaired projection — the same fulfillment the delivery would have performed. */
  fulfill?: (projection: PurchaseProjection) => Promise<void>;
  /** How many rows to take. Defaults to {@link ORPHAN_REPAIR_LIMIT}. */
  limit?: number;
}

/** What one repair pass did. Returned so a caller can log it and a test can assert on it. */
export interface RepairedOrphans {
  /** Rows examined — orphan-marked and unfinished, on this rail. */
  readonly examined: number;
  /** Rows whose purchase is now projected and whose event is now finished. */
  readonly projected: readonly string[];
  /** Rows still waiting: no owner yet, no replay, or nothing to project. Left exactly as they stood. */
  readonly waiting: number;
}

/**
 * Project the orphaned events on one rail that an owner can now be resolved for.
 *
 * Called after a link is written, on every path that writes one. Never throws for a row it cannot repair: a
 * replay that cannot read an old payload, an owner that still does not resolve, a projection the catalog
 * refuses — each leaves that row untouched and the pass moves to the next. The caller is a webhook handler
 * answering a store, and a repair failing must not turn a delivery that succeeded into a non-2xx.
 *
 * A row it *does* project is finished the same way the original delivery would have finished it, so the
 * store's own redelivery of it is a duplicate from then on.
 */
export async function repairOrphanedEvents(
  d1: D1Database,
  rail: PaymentsRail,
  options: RepairOrphansOptions,
): Promise<RepairedOrphans> {
  const projected: string[] = [];
  let examined = 0;
  let waiting = 0;

  if (options.replay === undefined) return { examined, projected, waiting };

  const db = paymentsDatabase(d1);
  const rows = await db
    .selectFrom(PAYMENTS_WEBHOOK_EVENTS_TABLE)
    .selectAll()
    .where("rail", "=", rail)
    // Unfinished. The marker check below is the narrow half, but this one is what a `processedAt` index can
    // serve, and it keeps a store's whole finished history out of the scan.
    .where("processedAt", "is", null)
    .where("error", "like", `${WEBHOOK_EVENT_ORPHANED}%`)
    // Oldest first: the queue drains in the order the purchases were made, not the order D1 happens to scan.
    .orderBy("receivedAt")
    .limit(options.limit ?? ORPHAN_REPAIR_LIMIT)
    .execute();

  for (const stored of rows) {
    const row = PaymentsWebhookEvent.parse(stored);
    // The predicate again, on the decoded row. The `where` above is the query this scan can afford; this is
    // the question being asked. They agree today, and a reader must not have to prove that to trust the set.
    if (!webhookEventAwaitsOwner(stored)) continue;
    examined += 1;

    const notification = await options.replay(row.payload);
    if (notification?.event === undefined || notification.event === null) {
      waiting += 1;
      continue;
    }

    // This row's own subject, resolved from this row's own hints. Both halves come back together or neither
    // does — `projection/owner.ts` reads them from one row for exactly this reason.
    const subject = await resolveNotificationOwner(db, rail, {
      providerAccountId: notification.providerAccountId,
      providerTransactionId: notification.event.providerTransactionId,
      originalTransactionId: notification.event.originalTransactionId,
    });
    if (subject === undefined) {
      // Still nobody. The link that just landed was somebody else's, and this row waits for its own.
      waiting += 1;
      continue;
    }

    let projection: PurchaseProjection;
    try {
      projection = await projectPurchase(
        d1,
        { ...notification.event, ...subject },
        { config: options.config, environment: options.environment, now: options.now },
      );
      if (notification.stateEvent) {
        await projectPurchase(
          d1,
          { ...notification.stateEvent, ...subject },
          { config: options.config, environment: options.environment, now: options.now },
        );
      }
      await options.fulfill?.(projection);
    } catch {
      // An unmapped SKU, a sandbox row in a production database, a ledger that would not assemble. None of
      // them is this link's fault and none is repaired by trying again here, so the row keeps its marker and
      // its reason and this pass moves on. The delivery that called us still succeeds.
      waiting += 1;
      continue;
    }

    await finish(d1, row.id, options.now);
    projected.push(row.providerEventId);
  }

  return { examined, projected, waiting };
}

/**
 * Mark a repaired row finished, and clear the reason it carried.
 *
 * `processedAt` because it now genuinely is finished — the purchase is projected, and a redelivery has
 * nothing left to add. The `error` goes with it: it said "no subject could be resolved", which stopped
 * being true, and a stale reason beside a finished timestamp is the contradiction `data/webhookEvent.ts`
 * refuses to store.
 *
 * `abandonedAt` is left exactly where it was. A sweep having given up on this row is a fact about that pass
 * and a record of how close the purchase came to being lost; `finished` already wins over it by construction.
 */
async function finish(d1: D1Database, id: string, now: Date): Promise<void> {
  await withD1Retry(() =>
    paymentsDatabase(d1)
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      .set({ processedAt: now.getTime(), error: null } as any)
      .where("id", "=", id)
      .execute(),
  );
}
