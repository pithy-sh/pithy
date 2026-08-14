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
import {
  isWebhookEventOutstanding,
  PaymentsWebhookEvent,
  WEBHOOK_EVENT_ORPHANED,
  webhookEventState,
} from "../data/webhookEvent";
import { fulfillPurchase } from "../grants/apply";
import { repairOrphanedEvents } from "../projection/orphans";
import { linkProviderAccount, resolveNotificationOwner } from "../projection/owner";
import { projectPurchase } from "../projection/writer";
import { noteIsRepairable, noteText } from "../rails/contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch } from "../rails/paddle/api";
import { PADDLE_EVENT_RETENTION_DAYS, sweepPaddleEvents } from "../rails/paddle/events";
import { PaddleEvent } from "../rails/paddle/objects";
import { PADDLE_ADJUSTMENTS_INCLUDE, readTransaction } from "../rails/paddle/read";
import { readPaddleEvent } from "../rails/paddle/webhook";
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
 * ## What a failed event costs, and for how long
 *
 * Two failures are available here and they are mirror images, so neither rule on its own is right.
 *
 * **Always skip.** Advancing past a failure turns a transient D1 fault into a permanently skipped
 * purchase. There is no second pass that would find it — that is the whole reason this sweep exists.
 *
 * **Always halt.** Leaving the cursor in front of the failure and retrying forever is correct for a
 * transient fault and wrong for a permanent one. A malformed event, a deleted transaction, a shape Paddle
 * changed — none of them clears on the next attempt, and the sweep then stands in front of that event for
 * good, so *every later purchase* becomes the one nothing ever finds. That is the same defect with the
 * blame moved.
 *
 * So this halts a **bounded** number of times and then quarantines: see {@link PADDLE_SWEEP_MAX_ATTEMPTS},
 * {@link fail} and {@link quarantine}. Under the bound, both timestamps stay null and the cursor stops in
 * front of the event, so the next run tries it again. At the bound, `abandonedAt` is stamped with an error
 * naming the quarantine and the attempts that earned it, the run's report names the event id, and the
 * cursor moves on. A row nobody can find is the same defect wearing the other hat, so the quarantine is
 * written in words on the row rather than being the absence of one.
 *
 * ## A quarantine bounds a stall; it does not end an event
 *
 * `abandonedAt` and `processedAt` are separate columns for one reason (#337). "This pass has given up" and
 * "this event is finished with" are different claims, and the webhook guard short-circuits on the second.
 * While the quarantine wrote `processedAt`, it also answered Paddle's ordinary retry — and an operator's
 * replay, which reuses the same `event_id` — with `duplicate`, so a quarantined purchase could never be
 * projected even after somebody fixed the cause. A bounded retry that is silently terminal is just the
 * "always skip" rule with extra steps.
 *
 * So an abandoned row is invisible to *this* sweep, which is what stops the attempt count restarting, and
 * fully visible to the webhook path, which is what repairs it. What this sweep repairs is a webhook that
 * was never delivered at all; what repairs a delivery that arrived and failed is the next delivery, and
 * `completeWebhook` no longer writes `processedAt` beside a repairable error.
 *
 * ## An orphan is abandoned, not finished (#339)
 *
 * An orphan is an event whose `custom_data` carries no `pithy_user` stamp, for a customer with no
 * `provider_accounts` row. This sweep used to call {@link complete} on one — the same `processedAt` that
 * means *finished with*.
 *
 * That was wrong, and it was wrong in the one way that costs a purchase. The webhook path treats its own
 * orphans as outstanding, and both paths write the **same row** under `UNIQUE (rail, providerEventId)`, so
 * whichever ran second decided. When the sweep ran first, the link then arrived and Paddle redelivered, the
 * guard read `processedAt`, answered `duplicate`, and the purchase was never projected. An orphan is the
 * textbook repairable delivery: nothing about the event is wrong, the world is simply missing a row that a
 * checkout, a client submission or an operator will add.
 *
 * The tension is real, though, and it is why `complete` looked reasonable. Leaving an orphan *outstanding*
 * makes {@link record} count it fresh every run, and {@link fail} halts the cursor in front of it — so one
 * customer who never links stalls every event behind them, daily, for as long as the deployment runs.
 *
 * `abandonedAt` is the state that already resolves exactly this, so it is used rather than a fourth one
 * invented for the occasion: abandoned is **invisible to this sweep**, so the cursor advances and nothing
 * stalls, and **not finished to the webhook guard**, so the redelivery that follows the link still repairs
 * it. See {@link abandon}. Unlike a quarantine it costs no attempts, because an orphan is not a failure
 * being retried — no number of sweeps conjures a link, so the first look is as informed as the tenth.
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
  /**
   * Events with a purchase in them and nobody to project it against, walked past and left repairable.
   *
   * **Paddle's own `evt_…` ids, and its own field rather than a share of `ignored`.** An ignored event is
   * one this build was never going to act on; an orphan is a real purchase waiting on a link that has not
   * arrived. Counting the second as the first is how {@link complete} came to be called on one — see the
   * module doc — and a number an operator reads as healthy is the wrong place to hide a stuck sale.
   *
   * Each entry is also a row carrying `abandonedAt` and its reason, repairable by any delivery of the same
   * event id once the link exists. **Named here because this sweep will not look again**, so the report is
   * where an operator learns there is a sale to chase — `refresh` cannot find it either, since an orphan
   * has no purchase row to re-read.
   */
  orphaned: string[];
  /** Events already recorded, so the sweep found nothing new. This is the healthy number. */
  duplicate: number;
  /** Events that could not be projected this run. Advancement stops at the first one that is not quarantined. */
  failed: number;
  /**
   * Events given up on this run — tried {@link PADDLE_SWEEP_MAX_ATTEMPTS} times and walked past.
   *
   * **Paddle's own `evt_…` ids, not a count.** A count says an operator has something to read and then
   * makes them go and find it; the id is what they replay, what they grep the table for, and what they
   * paste into Paddle's replay endpoint. `length` is still the count for a log line.
   *
   * Never empty quietly: each entry is also a row carrying `abandonedAt` and its reason. A run reporting
   * quarantines is a run that moved a purchase out of *its own* repair path, which is a decision somebody
   * should see rather than infer.
   */
  quarantined: string[];
  /** Where the cursor now stands, or null when it has never advanced. */
  cursor: string | null;
  /** A gap this run cannot close — a cursor past Paddle's retention — or null. */
  gap: string | null;
}

/** How many pages one sweep walks by default. Two hundred events a page, so this is 2,000 events. */
const DEFAULT_MAX_PAGES = 10;

/**
 * How many sweeps may try one event before it is quarantined and the stream moves on.
 *
 * **The unit is a run, and this sweep runs on a daily cron** — so three attempts is three days. That is
 * long enough for the faults a retry actually fixes: a D1 blip, a Paddle outage, a price somebody has to
 * add to the catalog after being paged. It is short enough that a fault no retry will ever fix costs the
 * stream three days rather than the rest of its life.
 *
 * One would be "always skip" with a counter bolted on. A hundred would be "always halt" with the same.
 */
export const PADDLE_SWEEP_MAX_ATTEMPTS = 3;

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
 * **`fresh` means "this pass still has work to do here", which is not the same as "not yet seen".** It asks
 * {@link isWebhookEventOutstanding}, so an event this sweep recorded and then failed to project — left
 * `pending` or `failed` by {@link fail} — comes back fresh and is tried again, while one that was
 * projected, fenced out, or is a type that projects nothing is finished and does not.
 *
 * **An orphan is not fresh either, and it is not finished — see {@link orphan}.** A row the *webhook* left
 * outstanding as an orphan still is, so the sweep picks it up, re-resolves the owner against a table that
 * may have gained the link since, and either projects it or abandons it. That re-resolution is the one
 * thing a second look at an orphan is worth, and it happens once.
 *
 * **A quarantined event is not fresh either, and that is a different reason.** It is still outstanding to a
 * webhook delivery, which must be allowed to repair it; it is not outstanding to *this* pass, because the
 * bound exists so one unprojectable event cannot hold the stream up for ever, and picking its own
 * quarantines back up would restart the count and stall again. Two readers, two questions — see
 * `data/webhookEvent.ts`.
 *
 * `attempts` comes back with it, because how many times this event has already been tried is what decides
 * whether the next failure halts the stream or gives up on it.
 */
async function record(
  d1: D1Database,
  eventId: string,
  payload: Record<string, unknown>,
  now: Date,
  newId: () => string,
): Promise<{ id: string; fresh: boolean; attempts: number }> {
  const db = paymentsDatabase(d1);
  const row = PaymentsWebhookEvent.encode({
    id: newId(),
    rail: "paddle",
    providerEventId: eventId,
    payload,
    receivedAt: now,
    processedAt: null,
    abandonedAt: null,
    error: null,
    attempts: 0,
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
    .select(["id", "processedAt", "abandonedAt", "error", "attempts"])
    .where("rail", "=", "paddle")
    .where("providerEventId", "=", eventId)
    .executeTakeFirst();
  return {
    id: stored?.id ?? row.id,
    fresh: stored === undefined || isWebhookEventOutstanding(webhookEventState(stored)),
    // The column is `NOT NULL DEFAULT 0`; the coalesce covers the row this call just inserted being read
    // back before the default is materialised, and a row the webhook path wrote before the column existed.
    attempts: stored?.attempts ?? 0,
  };
}

/**
 * Mark a recorded event **handled**, with the note when it was handled by deciding to do nothing.
 *
 * `processedAt` is the column the webhook guard short-circuits on, so it is set only where the event is
 * genuinely finished with: projected, fenced out, or a type that projects nothing. A failure is not one of
 * those — see {@link fail} — and neither is a quarantine, see {@link quarantine}.
 *
 * **Nor is an orphan, which is the whole of #339.** It reads like one — the sweep can do nothing more with
 * it, so "handled" is tempting — but the guard reads this column, and the event's repair is precisely the
 * redelivery that follows the missing link. See {@link abandon} and the module doc.
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
 * Record why an event could not be projected, count the attempt, and **leave both timestamps null**.
 *
 * The nulls are the whole of it. A `processedAt` beside the error would say "finished", and an
 * `abandonedAt` would say "given up on"; either would stop {@link record} counting the event outstanding,
 * the next sweep would advance the cursor past it, and no pass would ever look at it again — a transient
 * D1 fault turned into a permanently lost purchase. Two nulls with a non-null `error` is the honest
 * triple: it arrived, it was tried, it failed, and it is still outstanding to everyone.
 *
 * `receivedAt` beside a null `processedAt` is already the package's documented drift signal, so this
 * reports through a channel operators read rather than inventing a second one.
 */
async function fail(d1: D1Database, id: string, attempt: number, error: string): Promise<void> {
  await withD1Retry(() =>
    paymentsDatabase(d1)
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      .set({ processedAt: null, error, attempts: attempt } as any)
      .where("id", "=", id)
      .execute(),
  );
}

/** The word an operator greps `error` for. One string, so the writer and a runbook cannot drift apart. */
const QUARANTINED = "quarantined";

/**
 * The word for the other reason this sweep walks away from an event, likewise greppable.
 *
 * Shared with the webhook handler through `data/webhookEvent.ts` rather than spelled here, because the relink
 * repair queries on it: two writers with two sentences for one condition is a set that cannot be selected.
 */
const ORPHANED = WEBHOOK_EVENT_ORPHANED;

/**
 * Stamp `abandonedAt` and say in the row why — the one writer for *this pass has walked away from this*.
 *
 * **The state that is neither finished nor outstanding, and the reason there are two columns.**
 * {@link isWebhookEventOutstanding} reads it false, so this sweep's next run does not pick the event back
 * up and its cursor is free to advance. {@link isWebhookEventFinished} reads it false, so a later delivery
 * of the same event — the provider's retry, or an operator's replay, both reusing the original event id —
 * still runs the handler and can project the purchase.
 *
 * Two callers reach it for two different reasons and both want exactly that pair of answers: a quarantine,
 * which is a bounded retry giving up, and an orphan, which never had anything to retry. `attempts` is
 * written only when a caller counted any, so an orphan's row does not claim a failure it never had.
 */
async function abandon(d1: D1Database, id: string, now: Date, error: string, attempts?: number): Promise<void> {
  await withD1Retry(() =>
    paymentsDatabase(d1)
      .updateTable(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .set({
        abandonedAt: now.getTime(),
        error,
        ...(attempts === undefined ? {} : { attempts }),
        // biome-ignore lint/suspicious/noExplicitAny: encoded column values, not the app shape.
      } as any)
      .where("id", "=", id)
      .execute(),
  );
}

/**
 * Walk past an event with a purchase in it and nobody to project it against, and leave it repairable.
 *
 * **Not {@link complete}, and that reversal is #339.** Writing `processedAt` here told the webhook guard the
 * event was finished, and the two paths share one row — so a sweep that reached an orphan first made the
 * redelivery that arrives *after* the account links answer `duplicate`, and the purchase was never
 * projected. The one repair path for an orphan is the very delivery that write silenced.
 *
 * Not {@link fail} either, and that is the other half. A failure halts the cursor so the next run retries,
 * which is right for a fault that might clear; an orphan clears when a *link* appears, and no amount of
 * re-reading this event produces one. Halting would stall every event behind one customer, daily, for good.
 *
 * So: abandoned. Invisible to this sweep, still repairable by a delivery. The row says which of the two
 * reasons put it there, and names the command for an operator who would rather not wait for a redelivery.
 */
async function orphan(d1: D1Database, id: string, now: Date): Promise<void> {
  await abandon(
    d1,
    id,
    now,
    `${ORPHANED} no Pithy user could be resolved for this swept event, so the sweep has moved past it. It is not finished — the account linking re-examines it (see \`projection/orphans.ts\`), and any later delivery of this event id projects it too, including a replay from Paddle.`,
  );
}

/**
 * Give up on an event: stamp `abandonedAt` so this pass moves past it, and say in the row why.
 *
 * **`abandonedAt`, not `processedAt`, and the two columns are the whole fix for #337.** What this sweep
 * needs is for its own next run to stop counting the event fresh and restarting the attempt count — that is
 * a fact about *this pass*, and {@link record} reads it through {@link isWebhookEventOutstanding}. What it
 * emphatically must not do is tell the webhook guard the event is finished: writing `processedAt` here made
 * a quarantine answer Paddle's ordinary retry, and an operator's replay, with `duplicate` — so a
 * quarantined purchase could never be projected even once its cause was fixed. A quarantine bounds a
 * stall; it was never meant to be terminal.
 *
 * The row still says so in words. `error` names {@link QUARANTINED}, the attempt count, and the last
 * failure that earned it, so an operator reading the table has the reason and not only a timestamp.
 */
async function quarantine(d1: D1Database, id: string, attempt: number, now: Date, error: string): Promise<void> {
  await abandon(
    d1,
    id,
    now,
    `${QUARANTINED}: after ${attempt} attempts; the sweep has moved past it. Last failure: ${error}`,
    attempt,
  );
}

/**
 * Count one failed attempt against an event, and say whether the sweep may walk past it.
 *
 * `true` means quarantined — the caller advances its cursor. `false` means the bound has not been reached,
 * so the caller halts in front of the event and the next run tries again.
 */
async function attemptFailed(
  d1: D1Database,
  id: string,
  attempts: number,
  now: Date,
  reason: string,
): Promise<boolean> {
  const attempt = attempts + 1;
  if (attempt < PADDLE_SWEEP_MAX_ATTEMPTS) {
    await fail(d1, id, attempt, reason);
    return false;
  }
  await quarantine(d1, id, attempt, now, reason);
  return true;
}

/**
 * Project the orphans this link just made resolvable, and never let that fail the sweep.
 *
 * The events are gone from this pass's point of view — the cursor moved past them the run they were
 * abandoned — so an account linking is the only signal left that anything changed. The repair replays each
 * row's own recorded payload through the same map this sweep already uses, resolves the owner against the
 * table the link just landed in, and finishes only what it actually projected. See `projection/orphans.ts`.
 *
 * Swallowing here rather than in the repair: a sweep is a Workflow step, and a step that throws is retried
 * from the top — re-reading a page of Paddle events to repair a row that was never this page's business.
 */
async function repairOrphans(deps: PaddleSweepDeps, at: Date): Promise<void> {
  const base = {
    credentials: deps.credentials,
    environment: deps.paddleEnvironment,
    transport: deps.transport ?? paddleHttpFetch,
  };
  await repairOrphanedEvents(deps.d1, "paddle", {
    config: deps.config,
    environment: deps.environment,
    now: at,
    replay: async (payload) => {
      const parsed = PaddleEvent.safeParse(payload);
      if (!parsed.success) return undefined;
      return await readPaddleEvent(parsed.data, {
        credentials: deps.credentials,
        environment: deps.paddleEnvironment,
        now: at,
        deployment: deps.deployment,
        readTransaction: (id) => readTransaction(id, base, PADDLE_ADJUSTMENTS_INCLUDE),
      });
    },
    fulfill: async (projection) => {
      const fulfill =
        deps.fulfill ?? ((d1, value) => fulfillPurchase(d1, value, { config: deps.config, now: () => at.getTime() }));
      await fulfill(deps.d1, projection);
    },
  });
}

/** What to write in `error` for a thrown cause. A `PithyError`'s `detail` is throw-site context, not client text. */
function reasonFor(cause: unknown): string {
  if (cause instanceof PithyError) return `${cause.payload.code}: ${cause.payload.detail ?? cause.payload.message}`;
  return "projection failed";
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
    orphaned: [],
    duplicate: 0,
    failed: 0,
    quarantined: [],
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

      // **Before the allowlist check, because both leave `notification` null and they mean opposite
      // things.** A withheld type is walked past on purpose; an unreadable one is a failure that must be
      // recorded and counted. Reading them in the other order files every unreadable event as "ignored"
      // and advances the cursor over it — losing exactly the purchase this sweep exists to find.
      if (event.failure !== null) {
        // The event read cleanly out of the stream and then its *second* read — the transaction an
        // adjustment names — failed. Recorded so it has a row, a reason and an attempt count, then handled
        // by exactly the same bound as a projection failure: there is no reason one kind of unrepairable
        // event should hold the stream up forever and the other should not.
        const { id, fresh, attempts } = await record(deps.d1, event.eventId, event.failure.payload, at, newId);
        if (!fresh) {
          report.duplicate += 1;
          cursor = event.eventId;
          continue;
        }
        report.failed += 1;
        if (await attemptFailed(deps.d1, id, attempts, at, reasonFor(event.failure.cause))) {
          report.quarantined.push(event.eventId);
          cursor = event.eventId;
          continue;
        }
        report.cursor = cursor;
        if (cursor !== null) await writeCursor(deps.d1, cursor, at, newId);
        return report;
      }

      if (event.notification === null) {
        // A type the query asked Paddle to withhold and Paddle returned anyway. Not recorded — that is the
        // point of the allowlist, and `client_token.created` carries a live token. The cursor still
        // advances, because an event nothing here will ever act on is behind us the moment it is read.
        report.ignored += 1;
        cursor = event.eventId;
        continue;
      }

      const { notification } = event;
      const { id, fresh, attempts } = await record(deps.d1, event.eventId, notification.payload, at, newId);
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
        await repairOrphans(deps, at);
        // The link is what an orphan was waiting for, and this sweep will not look at those events again —
        // its cursor is past them. So the repair runs on the signal rather than on the next pass. #341.
      }

      if (notification.event === null) {
        // **A note a provider read produced is not a completion, and that is #341 on this path.** The rail
        // reads a transaction to tell a full refund from a partial one, and a read answering "no such
        // transaction" is exactly as repairable as one that threw — a rotated key, a shared sandbox, an
        // adjustment swept ahead of its own transaction. So it goes through the same bound the thrown case
        // above uses, rather than stamping `processedAt` and making Paddle's redelivery a duplicate.
        if (noteIsRepairable(notification.note)) {
          report.failed += 1;
          if (await attemptFailed(deps.d1, id, attempts, at, noteText(notification.note) ?? "unreadable")) {
            report.quarantined.push(event.eventId);
            cursor = event.eventId;
            continue;
          }
          report.cursor = cursor;
          if (cursor !== null) await writeCursor(deps.d1, cursor, at, newId);
          return report;
        }
        report.ignored += 1;
        await complete(deps.d1, id, at, noteText(notification.note));
        cursor = event.eventId;
        continue;
      }

      const userId = await resolveNotificationOwner(paymentsDatabase(deps.d1), "paddle", {
        providerAccountId: notification.providerAccountId,
        providerTransactionId: notification.event.providerTransactionId,
        originalTransactionId: notification.event.originalTransactionId,
      });
      if (!userId) {
        // Orphaned. No number of sweeps will conjure a link, so the cursor advances — retrying it forever
        // would stall every event behind one customer. But the event is **not finished**: it is a real
        // purchase waiting on a link, and the delivery that follows that link is what projects it. So
        // `abandonedAt`, which advances this pass and leaves the guard's short-circuit shut. See #339.
        report.orphaned.push(event.eventId);
        await orphan(deps.d1, id, at);
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
        // **Advancement stops here for a bounded number of runs, and the row stays unprocessed.** Every
        // event behind this one is unswept, which is correct while there is any prospect of the fault
        // clearing: skipping straight past would turn a transient fault into a purchase nothing ever
        // finds. So the row is left with a null `processedAt` and the next sweep sees it fresh.
        //
        // Once the attempt count reaches {@link PADDLE_SWEEP_MAX_ATTEMPTS}, the prospect is gone and
        // holding the stream is the more expensive answer — so the event is quarantined in words on its
        // own row and the cursor moves on. See the module doc: neither rule alone is right.
        report.failed += 1;
        if (await attemptFailed(deps.d1, id, attempts, at, reasonFor(cause))) {
          report.quarantined.push(event.eventId);
          cursor = event.eventId;
          continue;
        }
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
