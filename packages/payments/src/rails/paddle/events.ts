// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { VerifiedNotification } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";
import { PaddleEvent } from "./objects";
import { type ParsePaddleNotificationOptions, readPaddleEvent } from "./webhook";

/**
 * The events sweep — the repair `refresh` cannot make.
 *
 * `refresh` re-reads rows this deployment already holds. A purchase whose webhook was never delivered and
 * which no client submitted has no row, so it is invisible to `refresh` forever. Paddle publishes an
 * account-wide event stream, so this rail can find those, and no other rail in this package can.
 *
 * It carries more weight here than the issue credits, for a reason outside this rail: `completeWebhook`
 * sets `processedAt` even when it records an error, and the guard short-circuits any delivery whose
 * `processedAt` is not null. Paddle's replay endpoint reuses the same `event_id`, so replaying a delivery
 * that errored answers 200 and never reprocesses. That is a pre-existing defect across all four existing
 * rails and is **not** touched here — it is reported, not fixed — but until it is, the sweep is the only
 * repair for a delivery that arrived and failed.
 *
 * ## The stream is account-wide, and that is a hazard rather than a convenience
 *
 * Verified live: the assigned sandbox's own stream carries `api_key.created` and `client_token.created`.
 * The `api_key` payload's `key` is redacted by Paddle; **the `client_token` payload's `token` is not.**
 * Projecting every swept event through the webhook writer would fill `pithy_payments_webhook_events` with
 * product, price, api-key and client-token rows — and persist live client tokens into a table an operator
 * greps.
 *
 * So the filter is in the **query**, not in a branch afterwards. `client.events.list` takes `event_type[]`,
 * and this sends exactly the types the event map acts on. Nothing else is fetched, so nothing else can be
 * recorded, and a sweep of an account with a thousand price edits costs nothing.
 *
 * ## The cursor, and the 90-day cliff
 *
 * `order_by=id[ASC]&after=<cursor>`, with the cursor persisted in `pithy_payments_sync_cursors`. It
 * advances only past events fully projected, so the first failure halts advancement and the step retries
 * next run.
 *
 * **Paddle retains 90 days.** A cursor older than that can never be caught up — the events between it and
 * the retention window are gone — so this reports a gap naming the window rather than silently restarting
 * from the beginning and re-projecting three months of history.
 */

/** How many events one page asks for. Paddle's maximum, so a backlog is walked in as few calls as possible. */
export const PADDLE_SWEEP_PAGE_SIZE = 200;

/** How long Paddle keeps an event. Confirmed in the API reference and in the endpoint's own description. */
export const PADDLE_EVENT_RETENTION_DAYS = 90;

/**
 * Every event type the sweep asks for — exactly the ones {@link readPaddleEvent} can act on.
 *
 * A type absent here is a type never fetched, never recorded, and therefore never a client token in a
 * table. Adding a projection to the event map means adding its type here; a test asserts the two agree,
 * because a map that grew a case the sweep never fetches would repair through the webhook path and not
 * through the sweep, which is precisely the asymmetry the sweep exists to remove.
 */
export const PADDLE_SWEPT_EVENT_TYPES: readonly string[] = [
  "transaction.paid",
  "transaction.completed",
  "transaction.payment_failed",
  "transaction.past_due",
  "transaction.canceled",
  "transaction.updated",
  "transaction.revised",
  "transaction.billed",
  "subscription.created",
  "subscription.activated",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.canceled",
  "subscription.updated",
  "subscription.imported",
  "adjustment.created",
  "adjustment.updated",
];

/** What one sweep page needs. */
export interface PaddleSweepOptions extends ParsePaddleNotificationOptions {
  /** The rail's credentials. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to sweep. */
  environment: PaddleEnvironment;
  /** The event id to resume after, or undefined to start at the oldest retained event. */
  cursor?: string;
  /** How many events to ask for. Defaults to Paddle's maximum. */
  pageSize?: number;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/** One swept event: what it is, and what the shared event map made of it. */
export interface SweptEvent {
  /** Paddle's own event id — the same key the webhook path records, because the stream carries no other. */
  eventId: string;
  /** The event type, for the operator reading a run's report. */
  eventType: string;
  /** What the event map made of it. `event` is null for one that projects nothing. */
  notification: VerifiedNotification;
}

/** One page of the sweep. */
export interface PaddleSweepPage {
  /** The events on this page, oldest first. */
  events: readonly SweptEvent[];
  /** The cursor to resume after, or undefined when nothing was returned. */
  cursor?: string;
  /** Whether Paddle has more beyond this page. */
  hasMore: boolean;
  /**
   * A gap this run cannot close, or null.
   *
   * Set when the sweep was asked to resume from a cursor Paddle no longer knows — which is what a cursor
   * older than the retention window looks like. Reported rather than repaired: restarting from the
   * beginning would re-project three months, and pretending the gap is not there would leave it forever.
   */
  gap: string | null;
}

/** Sweep one page of Paddle's event stream, projecting each event through the same map a webhook uses. */
export async function sweepPaddleEvents(options: PaddleSweepOptions): Promise<PaddleSweepPage> {
  const query: [string, string][] = [
    ["order_by", "id[ASC]"],
    ["per_page", String(options.pageSize ?? PADDLE_SWEEP_PAGE_SIZE)],
  ];
  // The filter is in the query on purpose — see the module doc. `event_type[]` repeated, which is how
  // Paddle takes an array.
  for (const type of PADDLE_SWEPT_EVENT_TYPES) query.push(["event_type", type]);
  if (options.cursor !== undefined) query.push(["after", options.cursor]);

  let answer: Awaited<ReturnType<typeof paddleJson>>;
  try {
    answer = await paddleJson(options.transport ?? paddleHttpFetch, "/events", {
      what: "the event stream",
      apiKey: options.credentials.apiKey,
      environment: options.environment,
      query,
    });
  } catch (cause) {
    // A cursor Paddle will not resume from is the retention cliff, and it is not a transient failure —
    // retrying it forever would be a step that never succeeds. Reported as a gap the operator can act on.
    if (options.cursor !== undefined && isUnknownCursor(cause)) {
      return {
        events: [],
        cursor: options.cursor,
        hasMore: false,
        gap: `Paddle no longer knows event ${options.cursor}, so the sweep cannot resume from it. Paddle retains ${PADDLE_EVENT_RETENTION_DAYS} days of events, and anything between that cursor and the retention window is gone. Reconcile the affected purchases with \`pithy payments reconcile --rail paddle\`, then clear the cursor to restart from the oldest retained event.`,
      };
    }
    throw cause;
  }

  const parsed = z.array(PaddleEvent).safeParse(answer?.data);
  if (!parsed.success) {
    return { events: [], cursor: options.cursor, hasMore: false, gap: null };
  }

  const events: SweptEvent[] = [];
  for (const event of parsed.data) {
    events.push({
      eventId: event.event_id,
      eventType: event.event_type,
      notification: await readPaddleEvent(event, options),
    });
  }

  return {
    events,
    // The last event on the page, and only when there was one: advancing past an empty page would move
    // the cursor onto nothing.
    cursor: events.at(-1)?.eventId ?? options.cursor,
    hasMore: answer?.hasMore === true,
    gap: null,
  };
}

/** Whether Paddle's refusal is "I do not know that cursor" rather than a credential or an outage. */
function isUnknownCursor(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const payload = (cause as { payload?: { code?: string; detail?: string } }).payload;
  if (payload?.code !== "payments/rail_not_configured") return false;
  // Paddle's own words. Narrow on purpose: a 401 or a 403 folds into the same code and is a rotated key,
  // not a lost cursor, and reporting one as a retention gap would send an operator to the wrong page.
  return /not_found|invalid_field|entity_not_found/i.test(payload.detail ?? "");
}
