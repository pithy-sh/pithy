// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { VerifiedNotification } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";
import { PaddleEvent } from "./objects";
import { readTransaction } from "./read";
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
 * There are therefore **two** controls, and only one of them is ours.
 *
 * The **query filter** asks Paddle for exactly {@link PADDLE_SWEPT_EVENT_TYPES}. It is sent in the form
 * Paddle documents for an `array[string]` parameter — one key, values comma-separated,
 * `event_type=a,b,c` — verified against the live sandbox API on 2026-08-13: filtering on two of the six
 * types in that account's stream returned four events of exactly those two types, and an unrecognised
 * value is refused with `Request does not pass validation` rather than ignored. An earlier build sent
 * `event_type=a&event_type=b&…`, a repeated-key form Paddle documents nowhere; whether that form is read
 * as an array, as one of its values, or not at all is not something this package can know.
 *
 * The **recording allowlist** is the control this package owns. A returned event whose type is not on
 * that list yields a `null` notification, and the sweep writes no row for it at all. So an unhonoured
 * filter costs a wasted page rather than a client token in D1, and the safety of this module does not
 * rest on a query parameter being obeyed by someone else's service. See `recorded.ts` for the same
 * argument on the webhook path, where there is no query to filter and the subscribed-event list is set
 * by a human in Paddle's dashboard.
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

/** The same list as a set, for the lookup that decides whether an event is recorded at all. */
const SWEPT_EVENT_TYPES: ReadonlySet<string> = new Set(PADDLE_SWEPT_EVENT_TYPES);

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
  /**
   * What the event map made of it, or **null for a type this build does not record at all**.
   *
   * Null is not "projects nothing" — that is a notification whose `event` is null, and it still earns a
   * row. Null here means the type is off {@link PADDLE_SWEPT_EVENT_TYPES}, so Paddle returned something
   * the query asked it not to, and the caller must advance its cursor past the event without writing
   * anything. The body is never even read, so there is nothing to leak.
   */
  notification: VerifiedNotification | null;
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
    // One key, values comma-separated. That is the form Paddle documents for every `array[string]` query
    // parameter, and the form verified against the live API. It is a request, not a guarantee — the
    // allowlist below is what makes an unhonoured filter harmless.
    ["event_type", PADDLE_SWEPT_EVENT_TYPES.join(",")],
  ];
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

  // An adjustment says how much came off and never what the original was, so the map cannot tell a full
  // refund from a partial one without reading the transaction — and it refuses rather than guessing when
  // no reader is supplied. This module owns the credentials, the account and the transport, so it builds
  // the reader itself: a caller cannot forget what it was never asked for.
  const read: ParsePaddleNotificationOptions = {
    ...options,
    readTransaction:
      options.readTransaction ??
      ((id) =>
        readTransaction(id, {
          credentials: options.credentials,
          environment: options.environment,
          transport: options.transport ?? paddleHttpFetch,
        })),
  };

  const events: SweptEvent[] = [];
  for (const event of parsed.data) {
    events.push({
      eventId: event.event_id,
      eventType: event.event_type,
      // The allowlist, applied before the body is looked at. A type the query asked Paddle to withhold
      // and Paddle returned anyway is walked past, not recorded — see the module doc.
      notification: SWEPT_EVENT_TYPES.has(event.event_type) ? await readPaddleEvent(event, read) : null,
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
