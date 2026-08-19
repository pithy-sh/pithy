// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  isWebhookEventFinished,
  isWebhookEventOutstanding,
  PaymentsWebhookEvent,
  type PaymentsWebhookEventState,
  WEBHOOK_EVENT_ORPHANED,
  webhookEventAwaitsOwner,
  webhookEventState,
} from "./webhookEvent";

/**
 * The state a recorded delivery is in, and the two questions asked of it.
 *
 * These are unit assertions about the derivation, not the gates: what actually proves #337 closed is
 * `http/routes.workers.test.ts`, which drives real deliveries through the real guard on all five rails,
 * and `workflows/paddleSweep.workers.test.ts`, which drives the real sweep. This file exists for the one
 * thing those cannot reach cheaply — that the four states are genuinely distinct, and that the two readers
 * disagree about `abandoned`, which is the whole reason there are two of them.
 */

/** Epoch milliseconds, so a timestamp in a case is a timestamp rather than a truthy value. */
const AT = new Date("2026-08-13T09:00:00Z").getTime();

describe("webhookEventState", () => {
  test("a bare row is pending", () => {
    expect(webhookEventState({ processedAt: null, abandonedAt: null, error: null })).toBe("pending");
    // A row read back before defaults materialise, or one written by a path that selects fewer columns.
    expect(webhookEventState({})).toBe("pending");
  });

  test("a reason with no timestamp is failed", () => {
    expect(webhookEventState({ processedAt: null, abandonedAt: null, error: "projection blew up" })).toBe("failed");
  });

  test("abandonedAt is abandoned, whatever the reason says", () => {
    expect(webhookEventState({ processedAt: null, abandonedAt: AT, error: "quarantined after 3 attempts" })).toBe(
      "abandoned",
    );
  });

  test("processedAt is finished, with or without an error beside it", () => {
    expect(webhookEventState({ processedAt: AT, abandonedAt: null, error: null })).toBe("finished");
    // The row `completeWebhook` used to write, and the reason the guard could never repair a failure. It
    // can no longer be produced by this package, and it must still classify as finished rather than as
    // something new: a database written by an older build is the case this branch is for.
    expect(webhookEventState({ processedAt: AT, abandonedAt: null, error: "no Pithy user" })).toBe("finished");
  });

  test("finished wins over abandoned — a sweep gave up, and a delivery then projected it", () => {
    // The ordering is load-bearing. A webhook that repairs a quarantined event writes `processedAt` and
    // leaves `abandonedAt` where it was, so the row keeps how close the purchase came to being lost.
    expect(webhookEventState({ processedAt: AT, abandonedAt: AT - 1000, error: null })).toBe("finished");
  });

  test("epoch zero is a timestamp, not an absence", () => {
    // The falsy trap. `1970-01-01` is not a plausible `receivedAt`, but a truthiness check here would read
    // a legitimately stored zero as "never happened", and this is the module every reader delegates to.
    expect(webhookEventState({ processedAt: 0 })).toBe("finished");
    expect(webhookEventState({ abandonedAt: 0 })).toBe("abandoned");
  });
});

/** Every state, written out — so a reader below is asserted over the whole set rather than over a sample. */
const STATES: readonly PaymentsWebhookEventState[] = ["pending", "failed", "abandoned", "finished"];

describe("the two readers", () => {
  test("the guard short-circuits on finished alone", () => {
    expect(STATES.filter(isWebhookEventFinished)).toEqual(["finished"]);
  });

  test("a repair pass has work to do on pending and failed alone", () => {
    expect(STATES.filter(isWebhookEventOutstanding)).toEqual(["pending", "failed"]);
  });

  test("they disagree about abandoned, and that is the point", () => {
    // Stated from the other side, because it is the one case where the two questions must part company:
    // the sweep must walk past its own quarantine or the attempt count restarts for ever, and a webhook
    // delivery must be able to repair it or the quarantine is terminal.
    expect(isWebhookEventFinished("abandoned")).toBe(false);
    expect(isWebhookEventOutstanding("abandoned")).toBe(false);
  });
});

/**
 * **The third reader, and it asks about a reason rather than a state.** (#341)
 *
 * The two above are enough to decide what a *delivery* may do with a row. They cannot decide what an
 * *account linking* may do with one, because both the row a sweep quarantined after three failures and the
 * row it walked past for want of an owner are `abandoned`, and a link repairs exactly one of them.
 */
describe("the reader for the relink repair", () => {
  const orphaned = `${WEBHOOK_EVENT_ORPHANED} no subject could be resolved`;

  test("a row waiting on an owner is one, whether the sweep or the webhook left it", () => {
    // Both writers, both states. The sweep abandons so its stream advances; the webhook leaves its own
    // orphan failed so a redelivery repairs it. The link repairs both.
    expect(webhookEventAwaitsOwner({ abandonedAt: AT, error: orphaned })).toBe(true);
    expect(webhookEventAwaitsOwner({ processedAt: null, error: orphaned })).toBe(true);
  });

  test("a row unfinished for any other reason is not", () => {
    // The set has to be the *right* set, not merely a small one: re-running a quarantine or an unmapped SKU
    // on every account link is an unbounded retry loop triggered by unrelated traffic.
    expect(webhookEventAwaitsOwner({ abandonedAt: AT, error: "quarantined: after 3 attempts" })).toBe(false);
    expect(webhookEventAwaitsOwner({ error: "payments/product_not_found: no product" })).toBe(false);
    expect(webhookEventAwaitsOwner({ error: null })).toBe(false);
    // And the marker must be the prefix, not a substring: a note quoting the word is not an orphan.
    expect(webhookEventAwaitsOwner({ error: `a delivery the sweep once called ${orphaned}` })).toBe(false);
  });

  test("a finished row is never repaired again, whatever its reason still says", () => {
    // `finished` wins over everything — a row projected by a redelivery keeps the reason that explained why
    // it once could not be, and re-projecting it on the next link would be a second write of the same sale.
    expect(webhookEventAwaitsOwner({ processedAt: AT, abandonedAt: AT, error: orphaned })).toBe(false);
  });
});

describe("the row schema", () => {
  test("abandonedAt round-trips through the SQLite codec", () => {
    const row = PaymentsWebhookEvent.encode({
      id: "w1",
      rail: "paddle",
      providerEventId: "evt_01",
      payload: { hello: "world" },
      receivedAt: new Date(AT),
      processedAt: null,
      abandonedAt: new Date(AT + 5000),
      error: "quarantined after 3 attempts",
      attempts: 3,
      createdAt: new Date(AT),
    });
    expect(row.abandonedAt).toBe(AT + 5000);
    expect(PaymentsWebhookEvent.parse(row).abandonedAt).toEqual(new Date(AT + 5000));
  });

  test("a row with no abandonedAt at all still parses — the webhook path never writes one", () => {
    const parsed = PaymentsWebhookEvent.parse({
      id: "w2",
      rail: "stripe",
      providerEventId: "evt_02",
      payload: "{}",
      receivedAt: AT,
      processedAt: null,
      abandonedAt: null,
      error: null,
      createdAt: AT,
    });
    expect(parsed.abandonedAt).toBeNull();
  });
});
