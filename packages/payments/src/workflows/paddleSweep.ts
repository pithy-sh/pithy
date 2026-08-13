// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { PaymentsConfig } from "../config/config";
import { railEnabled } from "../config/config";
import type { PurchaseEnvironment } from "../data/purchase";
import { PADDLE_EVENTS_CURSOR, PaymentsSyncCursor } from "../data/syncCursor";
import { PAYMENTS_SYNC_CURSORS_TABLE, PAYMENTS_WEBHOOK_EVENTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsWebhookEvent } from "../data/webhookEvent";
import { fulfillPurchase } from "../grants/apply";
import { linkProviderAccount, resolveNotificationOwner } from "../projection/owner";
import { projectPurchase } from "../projection/writer";
import type { PaddleEnvironment, PaddleHttpFetch } from "../rails/paddle/api";
import { PADDLE_EVENT_RETENTION_DAYS, sweepPaddleEvents } from "../rails/paddle/events";
import type { PaymentsPaddleCredentials } from "../secret/registry";

/**
 * The Paddle events sweep, as a reconciliation step.
 *
 * `refresh` re-reads rows this deployment already holds. A purchase whose webhook was never delivered and
 * which no client submitted has **no row**, so it is invisible to `refresh` forever. Paddle publishes an
 * account-wide event stream, so this rail can find those — and no other rail in this package can.
 *
 * ## Why it writes through the webhook table rather than around it
 *
 * A swept event and its webhook are the *same event*: Paddle's stream carries `event_id` and no
 * `notification_id`, so the id here is the id the delivery would have recorded. Writing through
 * `pithy_payments_webhook_events` with the same `UNIQUE (rail, providerEventId)` is therefore what makes
 * the sweep idempotent against the webhook path *and* against itself — a sweep of an event already
 * delivered inserts nothing and projects nothing.
 *
 * It also keeps one answer to "did we hear about this": an operator reading that table sees every event
 * this deployment acted on, whichever door it came through.
 *
 * ## Why the cursor advances only past what was fully projected
 *
 * The first failure halts advancement, and the step retries next run. Advancing past a failure would turn
 * a transient D1 fault into a permanently skipped purchase, and there is no second pass that would find it
 * — that is the whole reason this sweep exists.
 *
 * **Halting the cursor is only half of it.** A failed event is left with `processedAt` null, because the
 * duplicate check reads that column: writing a timestamp beside the error would make the next sweep count
 * the event handled, advance the cursor past it, and lose it exactly as surely as advancing would have.
 * See {@link fail}, and the sibling this sweep does *not* fix, below.
 *
 * ## The sibling, reported and not touched
 *
 * `completeWebhook` in `http/webhookGuard.ts` sets `processedAt` even when it records an error, on every
 * rail. The webhook guard short-circuits any delivery whose `processedAt` is not null, and Paddle's replay
 * endpoint reuses the same `event_id`, so replaying a delivery that errored answers 200 and reprocesses
 * nothing. That is the same shape as the defect fixed here and it is **pre-existing across all rails**, so
 * it belongs to its own change. Until it is made, this sweep is the only repair for a delivery that
 * arrived and failed — which is one more reason the sweep's own copy had to stop doing it.
 */

/** What the sweep needs. Every seam is explicit, so a test drives it without stubbing a module. */
export interface PaddleSweepDeps {
  /** The app database the `pithy_payments_*` tables live in. */
  d1: D1Database;
  /** The resolved catalog — the writer's product lookup comes from it. */
  config: PaymentsConfig;
  /** This deployment's store environment. A swept sandbox purchase is refused in production, as ever. */
  environment: PurchaseEnvironment;
  /** Paddle's credentials, resolved through the secrets store by the caller. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to sweep. */
  paddleEnvironment: PaddleEnvironment;
  /** This deployment's `ENVIRONMENT`, for the shared-sandbox fence and the ownership proof. */
  deployment?: string;
  /** The clock. */
  now(): Date;
  /** The row-id minter, injected so a test is deterministic. */
  newId?: () => string;
  /** The HTTP seam. */
  transport?: PaddleHttpFetch;
  /** Fulfillment for a swept purchase. Defaults to {@link fulfillPurchase}, and is safe to repeat. */
  fulfill?: (d1: D1Database, projection: Parameters<typeof fulfillPurchase>[1]) => Promise<unknown>;
  /** How many pages one sweep may walk. A bound on the work, so a first pass finishes. */
  maxPages?: number;
}

/** What one sweep did. Returned through a `step.do`, so a replay restores it exactly. */
export interface PaddleSweepReport {
  /** Events read from the stream. */
  read: number;
  /** Events that produced a purchase row. */
  projected: number;
  /** Events that were authentic and projected nothing — a fenced delivery, a type the map ignores. */
  ignored: number;
  /** Events already recorded, so the sweep found nothing new. This is the healthy number. */
  duplicate: number;
  /** Events that could not be projected. Advancement stops at the first one. */
  failed: number;
  /** Where the cursor now stands, or null when it has never advanced. */
  cursor: string | null;
  /** A gap this run cannot close — a cursor past Paddle's retention — or null. */
  gap: string | null;
}

/** How many pages one sweep walks by default. Two hundred events a page, so this is 2,000 events. */
const DEFAULT_MAX_PAGES = 10;

/** Read the stored cursor for Paddle's event stream, or null when it has never advanced. */
async function readCursor(d1: D1Database): Promise<string | null> {
  const row = await paymentsDatabase(d1)
    .selectFrom(PAYMENTS_SYNC_CURSORS_TABLE)
    .select(["cursor"])
    .where("rail", "=", "paddle")
    .where("name", "=", PADDLE_EVENTS_CURSOR)
    .executeTakeFirst();
  return typeof row?.cursor === "string" ? row.cursor : null;
}

/** Write the cursor back, creating the row on the first sweep. */
async function writeCursor(d1: D1Database, cursor: string, now: Date, newId: () => string): Promise<void> {
  const db = paymentsDatabase(d1);
  const row = PaymentsSyncCursor.encode({
    id: newId(),
    rail: "paddle",
    name: PADDLE_EVENTS_CURSOR,
    cursor,
    updatedAt: now,
    createdAt: now,
  });
  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_SYNC_CURSORS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
      .values(row as any)
      // One cursor per stream: a second row would let two runs each believe they were authoritative.
      .onConflict((oc) => oc.columns(["rail", "name"]).doUpdateSet({ cursor, updatedAt: now.getTime() } as never))
      .execute(),
  );
}

/**
 * Record one swept event, or report that it was already recorded.
 *
 * The same `UNIQUE (rail, providerEventId)` insert the webhook guard makes, against the same table and the
 * same key. That is what makes a sweep of an already-delivered event a no-op rather than a second write.
 *
 * **`fresh` means "not yet handled", which is not the same as "not yet seen".** It is read off
 * `processedAt`, so an event this sweep recorded and then failed to project — `processedAt` left null by
 * {@link fail} — comes back fresh and is tried again. An event that was projected, fenced out or orphaned
 * carries a timestamp and does not.
 */
async function record(
  d1: D1Database,
  eventId: string,
  payload: Record<string, unknown>,
  now: Date,
  newId: () => string,
): Promise<{ id: string; fresh: boolean }> {
  const db = paymentsDatabase(d1);
  const row = PaymentsWebhookEvent.encode({
    id: newId(),
    rail: "paddle",
    providerEventId: eventId,
    payload,
    receivedAt: now,
    processedAt: null,
    error: null,
    createdAt: now,
  });
  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
      .values(row as any)
      // `DO NOTHING`: the first record is the one worth keeping, and overwriting would erase the `error`
      // explaining why the first attempt failed.
      .onConflict((oc) => oc.columns(["rail", "providerEventId"]).doNothing())
      .execute(),
  );
  const stored = await db
    .selectFrom(PAYMENTS_WEBHOOK_EVENTS_TABLE)
    .select(["id", "processedAt"])
    .where("rail", "=", "paddle")
    .where("providerEventId", "=", eventId)
    .executeTakeFirst();
  return { id: stored?.id ?? row.id, fresh: stored?.processedAt === null || stored?.processedAt === undefined };
}

/**
 * Mark a recorded event **handled**, with the note when it was handled by deciding to do nothing.
 *
 * `processedAt` is what {@link record} reads to know an event is behind us, so it is set only where the
 * event is genuinely finished with: projected, fenced out, orphaned, or a type that projects nothing. A
 * failure is not one of those — see {@link fail}.
 */
async function complete(d1: D1Database, id: string, now: Date, note?: string): Promise<void> {
  await withD1Retry(() =>
    paymentsDatabase(d1)
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      .set({ processedAt: now.getTime(), error: note ?? null } as any)
      .where("id", "=", id)
      .execute(),
  );
}

/**
 * Record why an event could not be projected, and **leave `processedAt` null** so the next sweep tries it.
 *
 * The distinction is the whole of it. Writing a timestamp beside the error would say "handled", which is
 * what {@link record} reads: the next sweep would count the event a duplicate, advance the cursor past it,
 * and no pass would ever look at it again — a transient D1 fault turned into a permanently lost purchase.
 * Null `processedAt` with a non-null `error` is the honest pair: it arrived, it was tried, it failed, and
 * it is still outstanding.
 *
 * `receivedAt` beside a null `processedAt` is already the package's documented drift signal, so this
 * reports through a channel operators read rather than inventing a second one.
 */
async function fail(d1: D1Database, id: string, error: string): Promise<void> {
  await withD1Retry(() =>
    paymentsDatabase(d1)
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      .set({ processedAt: null, error } as any)
      .where("id", "=", id)
      .execute(),
  );
}

/**
 * Sweep Paddle's event stream and project what it finds.
 *
 * Returns a report rather than throwing on a projection failure: one unprojectable event must not lose the
 * run's whole progress, and the cursor stopping in front of it is what makes it repairable. A store that
 * cannot be *reached* still throws, so the step fails and retries rather than recording a sweep that never
 * happened.
 */
export async function sweepPaddle(deps: PaddleSweepDeps): Promise<PaddleSweepReport> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const report: PaddleSweepReport = {
    read: 0,
    projected: 0,
    ignored: 0,
    duplicate: 0,
    failed: 0,
    cursor: null,
    gap: null,
  };

  if (!railEnabled(deps.config, "paddle")) return report;

  let cursor = await readCursor(deps.d1);
  report.cursor = cursor;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

  for (let page = 0; page < maxPages; page += 1) {
    const now = deps.now();
    const swept = await sweepPaddleEvents({
      credentials: deps.credentials,
      environment: deps.paddleEnvironment,
      now,
      deployment: deps.deployment,
      cursor: cursor ?? undefined,
      transport: deps.transport,
    });

    if (swept.gap !== null) {
      // A cursor Paddle no longer knows: the retention cliff. Reported, and the cursor is left exactly
      // where it stands — restarting would re-project ninety days, and silence would lose the gap.
      report.gap = swept.gap;
      return report;
    }

    if (swept.events.length === 0) return report;

    for (const event of swept.events) {
      report.read += 1;
      const at = deps.now();

      if (event.notification === null) {
        // A type the query asked Paddle to withhold and Paddle returned anyway. Not recorded — that is the
        // point of the allowlist, and `client_token.created` carries a live token. The cursor still
        // advances, because an event nothing here will ever act on is behind us the moment it is read.
        report.ignored += 1;
        cursor = event.eventId;
        continue;
      }

      const { notification } = event;
      const { id, fresh } = await record(deps.d1, event.eventId, notification.payload, at, newId);
      if (!fresh) {
        // Already recorded and already handled — the healthy case, and the one that makes two consecutive
        // sweeps idempotent. The cursor still advances past it: it is behind us either way.
        report.duplicate += 1;
        cursor = event.eventId;
        continue;
      }

      // The pairing is worth keeping even for an event that projects nothing, and it is proven — the rail
      // returns a reference only when a MAC this deployment's secret produced sits beside it.
      if (notification.providerAccountId && notification.accountReference) {
        await linkProviderAccount(deps.d1, "paddle", notification.providerAccountId, notification.accountReference, {
          now: at,
        });
      }

      if (notification.event === null) {
        report.ignored += 1;
        await complete(deps.d1, id, at, notification.note ?? undefined);
        cursor = event.eventId;
        continue;
      }

      const userId = await resolveNotificationOwner(paymentsDatabase(deps.d1), "paddle", {
        providerAccountId: notification.providerAccountId,
        providerTransactionId: notification.event.providerTransactionId,
        originalTransactionId: notification.event.originalTransactionId,
      });
      if (!userId) {
        // Orphaned. No number of sweeps will conjure a link, so the row and its reason are what make it
        // repairable — and the cursor advances, because retrying it forever would stall every event behind.
        report.ignored += 1;
        await complete(deps.d1, id, at, "no Pithy user could be resolved for this swept event");
        cursor = event.eventId;
        continue;
      }

      try {
        const projection = await projectPurchase(
          deps.d1,
          { ...notification.event, userId },
          { config: deps.config, environment: deps.environment, now: at },
        );
        if (notification.stateEvent) {
          await projectPurchase(
            deps.d1,
            { ...notification.stateEvent, userId },
            { config: deps.config, environment: deps.environment, now: at },
          );
        }
        // The same fulfillment the webhook path performs. A sweep that repaired a renewal and did not
        // credit its coins would leave the entitlement right and the balance wrong, and nothing else would
        // ever fix it — the renewal this sweep discovered is the one the webhook lost.
        const fulfill =
          deps.fulfill ?? ((d1, value) => fulfillPurchase(d1, value, { config: deps.config, now: () => at.getTime() }));
        await fulfill(deps.d1, projection);
        await complete(deps.d1, id, at);
        report.projected += 1;
        cursor = event.eventId;
      } catch (cause) {
        // **Advancement stops here, and the row stays unprocessed.** Every event behind this one is
        // unswept, which is correct: skipping it would turn a transient fault into a purchase nothing ever
        // finds. And the failed event itself is left with a null `processedAt`, so the next sweep sees it
        // as fresh and tries again rather than counting it a duplicate and walking past it forever.
        report.failed += 1;
        await fail(
          deps.d1,
          id,
          cause instanceof PithyError
            ? `${cause.payload.code}: ${cause.payload.detail ?? cause.payload.message}`
            : "projection failed",
        );
        report.cursor = cursor;
        if (cursor !== null) await writeCursor(deps.d1, cursor, at, newId);
        return report;
      }
    }

    report.cursor = cursor;
    if (cursor !== null) await writeCursor(deps.d1, cursor, deps.now(), newId);
    if (!swept.hasMore) return report;
  }

  return report;
}

/** How long Paddle keeps an event, re-exported so a caller reporting a gap need not import two modules. */
export { PADDLE_EVENT_RETENTION_DAYS };
