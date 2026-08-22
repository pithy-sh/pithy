// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaddleEvent } from "./objects";

/**
 * What of a Paddle event this build writes down — the control that keeps a live client token out of D1.
 *
 * ## The hazard
 *
 * Paddle's notification destinations and its `/events` stream are **account-wide**. A destination
 * subscribed to `*`, or a sweep whose query filter is not honored, carries `api_key.*`,
 * `client_token.*`, `product.*`, `price.*` and `discount.*` alongside the events this package acts on.
 * Verified against the assigned sandbox's own stream: it carries `api_key.created` and
 * `client_token.created`, and while Paddle redacts the api key's `key`, **it does not redact the client
 * token's `token`.**
 *
 * `PaddleEvent` is `.loose()` and its `data` is `z.record(z.string(), z.unknown())`, so nothing in the
 * schema narrows an unknown event's body. Storing the delivery whole therefore persists a live credential
 * into `pithy_payments_webhook_events` — a table an operator greps, an export copies, and a backup keeps.
 *
 * ## Why the control is here rather than in the query
 *
 * The sweep does ask Paddle for only the types below, and that filter is worth having. But a query
 * parameter is a *request*: it is honored by someone else's service, on someone else's release cadence,
 * and it does not exist at all on the webhook path, where the subscribed-event list is set in Paddle's
 * dashboard by a human. An allowlist on what is **recorded** is a control this package owns and can prove.
 *
 * So: a type on this list is recorded whole, because its body is a transaction, a subscription or an
 * adjustment and that body is the replay source. A type not on this list is recorded as its **envelope
 * only** — id, type, and when — which keeps the row that makes the event id idempotent and drops the body
 * this build was never going to read.
 */

/**
 * Every event type recorded in full. Exactly the types the event map in `webhook.ts` acts on.
 *
 * Written out rather than derived from that module's sets on purpose: a list computed from the thing it is
 * meant to constrain cannot constrain it. `recorded.test.ts` cross-checks the two declarations against
 * each other in both directions, so adding a case to the map without adding its type here fails, and so
 * does the reverse.
 */
export const PADDLE_RECORDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "transaction.created",
  "transaction.ready",
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
]);

/**
 * What to store for this event: the whole delivery, or the envelope alone.
 *
 * The envelope keeps `event_id` — which is the whole point of the row, since `UNIQUE (rail,
 * providerEventId)` is what makes a redelivery recognized rather than reprocessed — plus the type and the
 * time, so an operator can still see that an event arrived and what it was. Everything else is dropped,
 * including any top-level key `.loose()` let through, because a key this build cannot name is a key it
 * cannot vouch for.
 */
export function recordedPayload(event: PaddleEvent): Record<string, unknown> {
  if (PADDLE_RECORDED_EVENT_TYPES.has(event.event_type)) return { ...event };
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
  };
}
