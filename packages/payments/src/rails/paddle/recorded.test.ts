// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaddleEvent } from "./objects";
import { PADDLE_RECORDED_EVENT_TYPES, recordedPayload } from "./recorded";
import {
  PADDLE_ADJUSTMENT_EVENTS,
  PADDLE_SUBSCRIPTION_EVENTS,
  PADDLE_TRANSACTION_EVENTS,
  PADDLE_TRANSACTION_EVENTS_WITHOUT_STATE,
} from "./webhook";

/**
 * The allowlist, and the credential it exists to keep out of D1.
 *
 * The population is Paddle's own published event-type enum, transcribed from the API reference rather than
 * computed from anything in this package. A test whose "everything else" is derived from the allowlist
 * would be comparing a set against itself, and would pass on an allowlist containing every type there is.
 */

/**
 * Every event type Paddle publishes, from the `event_type` enum on `GET /events`. Read 2026-08-13.
 *
 * Transcribed on purpose. It is the only thing here that knows what an unlisted type looks like, and the
 * anti-vacuity guard below is stated against its real size rather than against a number that would still
 * hold if it were empty.
 */
const PADDLE_EVERY_EVENT_TYPE: readonly string[] = [
  "address.created",
  "address.imported",
  "address.updated",
  "adjustment.created",
  "adjustment.updated",
  "api_key.created",
  "api_key.expired",
  "api_key.expiring",
  "api_key.revoked",
  "api_key.updated",
  "api_key_exposure.created",
  "business.created",
  "business.imported",
  "business.updated",
  "client_token.created",
  "client_token.revoked",
  "client_token.updated",
  "customer.created",
  "customer.imported",
  "customer.updated",
  "discount.created",
  "discount.imported",
  "discount.updated",
  "discount_group.created",
  "discount_group.updated",
  "payment_method.saved",
  "payment_method.deleted",
  "payout.created",
  "payout.paid",
  "price.created",
  "price.imported",
  "price.updated",
  "product.created",
  "product.imported",
  "product.updated",
  "report.created",
  "report.updated",
  "subscription.activated",
  "subscription.canceled",
  "subscription.created",
  "subscription.imported",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.updated",
  "transaction.billed",
  "transaction.canceled",
  "transaction.completed",
  "transaction.created",
  "transaction.paid",
  "transaction.past_due",
  "transaction.payment_failed",
  "transaction.ready",
  "transaction.revised",
  "transaction.updated",
];

/** A `client_token.created` exactly as Paddle sends it, token and all. */
const TOKEN = "test_c0ffee0000000000000planted";
function clientTokenCreated(): PaddleEvent {
  return PaddleEvent.parse({
    event_id: "evt_01hv8wptq8987qeep44cyrewp9",
    event_type: "client_token.created",
    occurred_at: "2026-08-12T09:00:00Z",
    // Paddle redacts an api key's `key`. It does not redact a client token's `token`.
    data: { id: "ctkn_01", name: "Website", token: TOKEN, status: "active" },
    // `.loose()` lets anything else through too, so the redaction has to drop what it cannot name.
    notification_id: "ntf_01",
    smuggled: { token: TOKEN },
  });
}

describe("PADDLE_RECORDED_EVENT_TYPES", () => {
  test("every type the event map acts on is recorded in full", async () => {
    // Otherwise an event this build projects would be stored without the body that is its replay source.
    const acted = [
      ...PADDLE_TRANSACTION_EVENTS,
      ...PADDLE_TRANSACTION_EVENTS_WITHOUT_STATE,
      ...PADDLE_SUBSCRIPTION_EVENTS,
      ...PADDLE_ADJUSTMENT_EVENTS,
    ];
    for (const type of acted) expect(PADDLE_RECORDED_EVENT_TYPES.has(type), type).toBe(true);
    // Anti-vacuity against the real population: the map acts on twenty-one types, not on none.
    expect(acted.length).toBeGreaterThanOrEqual(21);
  });

  test("nothing is recorded in full that the event map does not act on", async () => {
    // The direction that keeps the list from quietly growing back toward `*`.
    const acted = new Set([
      ...PADDLE_TRANSACTION_EVENTS,
      ...PADDLE_TRANSACTION_EVENTS_WITHOUT_STATE,
      ...PADDLE_SUBSCRIPTION_EVENTS,
      ...PADDLE_ADJUSTMENT_EVENTS,
    ]);
    for (const type of PADDLE_RECORDED_EVENT_TYPES) expect(acted.has(type), type).toBe(true);
  });

  test("the allowlist is a minority of what Paddle publishes, and excludes every credential-bearing type", async () => {
    // Stated against Paddle's own enum. An allowlist that had grown to everything would pass a check
    // derived from itself and fail this one.
    const unlisted = PADDLE_EVERY_EVENT_TYPE.filter((type) => !PADDLE_RECORDED_EVENT_TYPES.has(type));
    expect(PADDLE_EVERY_EVENT_TYPE.length).toBeGreaterThanOrEqual(55);
    expect(unlisted.length).toBeGreaterThanOrEqual(30);
    for (const type of ["client_token.created", "client_token.updated", "client_token.revoked"]) {
      expect(unlisted, type).toContain(type);
    }
    for (const type of ["api_key.created", "api_key.updated", "api_key_exposure.created"]) {
      expect(unlisted, type).toContain(type);
    }
  });
});

describe("recordedPayload", () => {
  test("a client token event is stored as its envelope, and the token is nowhere in it", async () => {
    // The defect, in the one form that matters: what actually reaches `pithy_payments_webhook_events`.
    // Asserted against the serialized row, because that is what a grep, an export and a backup see.
    const payload = recordedPayload(clientTokenCreated());
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload.data).toBeUndefined();
    // `.loose()` carried two more keys in. Neither survives, because a key this build cannot name is a
    // key it cannot vouch for — and one of them was hiding the same token.
    expect(payload.smuggled).toBeUndefined();
    expect(payload.notification_id).toBeUndefined();
    // What is kept is what the row is for: the id `UNIQUE (rail, providerEventId)` de-duplicates on.
    expect(payload).toEqual({
      event_id: "evt_01hv8wptq8987qeep44cyrewp9",
      event_type: "client_token.created",
      occurred_at: "2026-08-12T09:00:00Z",
    });
  });

  test("the planted token is genuinely in the event, so the assertion above had something to find", async () => {
    // Anti-vacuity. Without this, a fixture that never carried the token would make the redaction gate
    // pass on an empty search.
    expect(JSON.stringify(clientTokenCreated())).toContain(TOKEN);
  });

  test("an acted-on event is stored whole, so the replay source survives", async () => {
    const event = PaddleEvent.parse({
      event_id: "evt_02",
      event_type: "transaction.completed",
      occurred_at: "2026-08-12T09:00:00Z",
      data: { id: "txn_01", status: "completed", custom_data: { pithy_user: "ada" } },
      notification_id: "ntf_02",
    });
    const payload = recordedPayload(event);
    expect(payload.data).toEqual({ id: "txn_01", status: "completed", custom_data: { pithy_user: "ada" } });
    expect(payload.notification_id).toBe("ntf_02");
  });

  test("a type Paddle ships after this package did is an envelope, not a body", async () => {
    // The default has to be deny. A build that stored an unrecognised type whole would have shipped this
    // defect again the next time Paddle added an event carrying a secret.
    const payload = recordedPayload(
      PaddleEvent.parse({
        event_id: "evt_03",
        event_type: "something.paddle_added_later",
        occurred_at: "2026-08-12T09:00:00Z",
        data: { secret: "unguessable" },
      }),
    );
    expect(payload.data).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("unguessable");
  });
});
