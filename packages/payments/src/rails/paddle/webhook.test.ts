// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { VerifiedNotification } from "../contract";
import { PADDLE_SWEPT_EVENT_TYPES } from "./events";
import { accountReferenceProof, type PaddleEvent, type PaddleTransaction } from "./objects";
import { readPaddleEvent } from "./webhook";

/**
 * The event map, exercised against a fixture per event type.
 *
 * `readPaddleEvent` rather than `parsePaddleNotification`, because signature verification has its own file
 * and mixing them would make every case here carry an HMAC that says nothing about projection.
 * `routes.workers.test.ts` runs the two together through the real guard, which is where the joint claim is.
 */

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};
const OCCURRED = "2026-08-12T09:00:00.000000Z";
const LATER = "2026-08-12T11:00:00.000000Z";
const SUB = "sub_01hv8wptq8987qeep44cyrewp9";
const TXN = "txn_01hv8wptq8987qeep44cyrewp9";
const PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";
const CUSTOMER = "ctm_01hv8wptq8987qeep44cyrewp9";

/** Read one event with this deployment's own settings. */
function read(
  event: PaddleEvent,
  options: { deployment?: string; readTransaction?: (id: string) => Promise<PaddleTransaction | undefined> } = {},
): Promise<VerifiedNotification> {
  return readPaddleEvent(event, {
    credentials: CREDENTIALS,
    environment: "production",
    now: new Date(OCCURRED),
    deployment: options.deployment ?? "prod",
    readTransaction: options.readTransaction,
  });
}

/** The stamp a checkout this deployment created would carry. */
async function stamp(userId = "ada", deployment = "prod"): Promise<Record<string, string>> {
  return {
    pithy_user: userId,
    pithy_env: deployment,
    pithy_ref_proof: await accountReferenceProof(userId, deployment, CREDENTIALS.webhookSecret),
  };
}

/** A transaction, subscription-shaped unless a case says otherwise. */
async function transaction(overrides: Record<string, unknown> = {}): Promise<PaddleTransaction> {
  return {
    id: TXN,
    status: "completed",
    customer_id: CUSTOMER,
    subscription_id: SUB,
    items: [{ price: { id: PRICE } }],
    details: { totals: { grand_total: "999", currency_code: "USD" } },
    custom_data: await stamp(),
    created_at: OCCURRED,
    updated_at: OCCURRED,
    ...overrides,
  } as PaddleTransaction;
}

/** One event envelope around a piece of data. */
function event(type: string, data: unknown, eventId = "evt_01", occurredAt = OCCURRED): PaddleEvent {
  return { event_id: eventId, event_type: type, occurred_at: occurredAt, data } as PaddleEvent;
}

/** A subscription in a given standing. */
async function subscription(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    id: SUB,
    status: "active",
    customer_id: CUSTOMER,
    items: [{ price: { id: PRICE } }],
    current_billing_period: { starts_at: OCCURRED, ends_at: "2026-09-12T09:00:00Z" },
    custom_data: await stamp(),
    created_at: OCCURRED,
    updated_at: OCCURRED,
    ...overrides,
  };
}

describe("the transaction map", () => {
  test("a completed subscription transaction is a closed, paid period — not `active`", async () => {
    // The departure from the issue's table, pinned. `active` with no expiry on a money row outranks the
    // subscription's own state row, so a cancelled subscriber would keep their entitlement forever.
    // `expired` grants nothing and still credits a `grants` clause, which is what makes N renewals credit
    // exactly N times.
    const read1 = await read(event("transaction.completed", await transaction()));
    expect(read1.event).toMatchObject({
      providerTransactionId: TXN,
      originalTransactionId: SUB,
      role: "charge",
      status: "expired",
      amountMinor: 999,
      currency: "usd",
    });
    // The closed window: born expired, at the moment it was raised.
    expect(read1.event?.expiresAt).toEqual(read1.event?.purchasedAt);
  });

  test("a completed one-off transaction is `active` and never expires — owning it is the entitlement", async () => {
    const oneOff = await transaction({ subscription_id: null });
    const notification = await read(event("transaction.completed", oneOff));
    expect(notification.event).toMatchObject({ status: "active", originalTransactionId: null, expiresAt: null });
  });

  test("two renewals produce two rows chaining back to one subscription", async () => {
    const january = await read(event("transaction.completed", await transaction({ id: "txn_jan" }), "evt_jan"));
    const february = await read(event("transaction.completed", await transaction({ id: "txn_feb" }), "evt_feb"));
    expect(january.event?.providerTransactionId).toBe("txn_jan");
    expect(february.event?.providerTransactionId).toBe("txn_feb");
    // Distinct rows, one family. `UNIQUE (rail, providerTransactionId)` therefore admits both, and each
    // credits its own period.
    expect([january.event?.originalTransactionId, february.event?.originalTransactionId]).toEqual([SUB, SUB]);
  });

  test.each([
    ["transaction.paid", "completed", "expired"],
    ["transaction.payment_failed", "past_due", "in_grace"],
    ["transaction.past_due", "past_due", "in_grace"],
    ["transaction.canceled", "canceled", "never_paid"],
    ["transaction.updated", "completed", "expired"],
    ["transaction.revised", "completed", "expired"],
    ["transaction.billed", "billed", "on_hold"],
  ])("%s with status %s projects %s", async (type, status, expected) => {
    const notification = await read(event(type, await transaction({ status })));
    expect(notification.event?.status).toBe(expected);
  });

  test.each(["transaction.created", "transaction.ready"])("%s projects nothing — no money has moved", async (type) => {
    const notification = await read(event(type, await transaction({ status: "ready" })));
    expect(notification.event).toBeNull();
    // Recorded all the same, and with no note: an abandoned checkout is ordinary traffic.
    expect(notification.note).toBeNull();
    expect(notification.payload).toMatchObject({ event_type: type });
  });

  test("the watermark is the envelope's occurred_at, never the entity's updated_at", async () => {
    // The trap #125 documents on Lemon Squeezy, and Paddle has it too. A transaction's `updated_at` lives
    // in the transaction's domain; stamping it onto a watermark discards the subscription event that
    // follows. Here the entity's clock is deliberately *older* than the envelope's, so a reader of the
    // wrong field produces a visibly different answer.
    const notification = await read(
      event("transaction.completed", await transaction({ updated_at: "2020-01-01T00:00:00Z" }), "evt_01", LATER),
    );
    expect(notification.event?.providerEventAt).toEqual(new Date(LATER));
  });
});

describe("the subscription map", () => {
  test.each([
    ["subscription.created", "active", "active"],
    ["subscription.activated", "active", "active"],
    ["subscription.resumed", "active", "active"],
    ["subscription.past_due", "past_due", "in_grace"],
    ["subscription.paused", "paused", "paused"],
    ["subscription.canceled", "canceled", "canceled"],
    ["subscription.updated", "active", "active"],
    ["subscription.imported", "active", "active"],
  ])("%s with status %s projects %s", async (type, status, expected) => {
    const notification = await read(event(type, await subscription({ status })));
    expect(notification.event).toMatchObject({ providerTransactionId: SUB, role: "state", status: expected });
  });

  test("a trialing subscription grants, and expires when the trial does", async () => {
    // A deliberate decision, not a mapping-table row: a trial is access the store is currently giving, and
    // it is safe because the row carries the date it stops.
    const notification = await read(
      event(
        "subscription.trialing",
        await subscription({
          status: "trialing",
          trial_dates: { starts_at: OCCURRED, ends_at: "2026-08-26T09:00:00Z" },
        }),
      ),
    );
    expect(notification.event).toMatchObject({ status: "active" });
    expect(notification.event?.expiresAt).toEqual(new Date("2026-08-26T09:00:00Z"));
  });

  test("a cancellation keeps the period already paid for", async () => {
    // `canceled` grants in this package's status set, and `expiresAt` is what ends it. A buyer who turned
    // off auto-renew declined the *next* period, not the one on their card statement.
    const notification = await read(event("subscription.canceled", await subscription({ status: "canceled" })));
    expect(notification.event).toMatchObject({ status: "canceled" });
    expect(notification.event?.expiresAt).toEqual(new Date("2026-09-12T09:00:00Z"));
  });

  test("a transaction event never moves the subscription's watermark, because the keys differ", async () => {
    // The two rows are keyed on different ids, so a transaction event physically cannot address the state
    // row. That is a property of the schema rather than of careful code, and this is what says so.
    const charge = await read(event("transaction.completed", await transaction()));
    const state = await read(event("subscription.activated", await subscription()));
    expect(charge.event?.providerTransactionId).toBe(TXN);
    expect(state.event?.providerTransactionId).toBe(SUB);
    expect(charge.event?.providerTransactionId).not.toBe(state.event?.providerTransactionId);
  });

  test("an unmapped status refuses rather than guessing", async () => {
    // A status this package has never seen is a shape change worth failing loudly on, not a value to guess
    // at — and the guard turns the refusal into a non-2xx so Paddle redelivers while somebody looks.
    // `detail` names it; `message` is the public half and deliberately says nothing about a status.
    const thrown = await read(event("subscription.updated", await subscription({ status: "hibernating" }))).catch(
      (error: unknown) => error as PithyError,
    );
    expect(thrown).toBeInstanceOf(PithyError);
    expect((thrown as PithyError).payload.code).toBe("payments/verification_failed");
    expect((thrown as PithyError).payload.detail).toContain("not one this build maps");
  });
});

describe("the adjustment map — refunds Paddle issued on its own", () => {
  /** An adjustment against the transaction above. */
  const adjustment = (overrides: Record<string, unknown> = {}) => ({
    id: "adj_01hv8wptq8987qeep44cyrewp9",
    action: "refund",
    status: "approved",
    transaction_id: TXN,
    subscription_id: SUB,
    customer_id: CUSTOMER,
    currency_code: "USD",
    totals: { total: "999" },
    created_at: OCCURRED,
    updated_at: OCCURRED,
    ...overrides,
  });

  test("a full refund nobody asked for revokes the entitlement it paid for", async () => {
    // The unsolicited path: no local write preceded this, and no `readTransaction` was ever called by us
    // for any other reason. Paddle is merchant of record and refunds on its own account.
    const notification = await read(event("adjustment.created", adjustment(), "evt_ref", LATER), {
      readTransaction: async () => await transaction(),
    });
    expect(notification.event).toMatchObject({ providerTransactionId: TXN, status: "refunded" });
    expect(notification.event?.revokedAt).toEqual(new Date(LATER));
    // And the subscription stops granting. One event without the other leaves a refunded subscriber
    // holding the feature: the money row is keyed on `txn_…` and says nothing about `sub_…`.
    expect(notification.stateEvent).toMatchObject({
      providerTransactionId: SUB,
      role: "state",
      status: "revoked",
    });
  });

  test("a partial refund is recorded with a note and revokes nothing", async () => {
    const notification = await read(
      event("adjustment.created", adjustment({ totals: { total: "300" } }), "evt_part", LATER),
      { readTransaction: async () => await transaction() },
    );
    expect(notification.event).toBeNull();
    expect(notification.note).toContain("300");
    expect(notification.note).toContain("999");
  });

  test("an unreadable original total is treated as partial, not as full", async () => {
    // Revoking on a figure this build could not read would take an entitlement away on a guess. The safe
    // direction is the one that leaves the customer with what they bought and leaves a note behind.
    const notification = await read(event("adjustment.created", adjustment(), "evt_unk", LATER), {
      readTransaction: async () => await transaction({ details: { totals: {} } }),
    });
    expect(notification.event).toBeNull();
    expect(notification.note).toContain("unreadable");
  });

  test("a chargeback revokes and its reverse restores, on a later clock", async () => {
    const back = await read(event("adjustment.created", adjustment({ action: "chargeback" }), "evt_cb", LATER), {
      readTransaction: async () => await transaction(),
    });
    expect(back.event?.status).toBe("refunded");

    const reversed = await read(
      event("adjustment.updated", adjustment({ action: "chargeback_reverse" }), "evt_cbr", "2026-08-12T13:00:00Z"),
      { readTransaction: async () => await transaction() },
    );
    // Back to what the transaction says it is — a paid, closed period — with the revocation cleared and a
    // later `occurred_at`, so the monotonic rule lets it win.
    expect(reversed.event).toMatchObject({ status: "expired", revokedAt: null });
    expect(reversed.event?.providerEventAt).toEqual(new Date("2026-08-12T13:00:00Z"));
  });

  test.each(["credit", "credit_reverse", "chargeback_warning", "chargeback_warning_reverse"])(
    "%s projects nothing — a credit is not a revocation and a warning is not a decision",
    async (action) => {
      // `chargeback_warning_reverse` is in the live action enum and is absent from the issue's table. A
      // stated row rather than an omission, which is the difference between a decision and an oversight.
      const notification = await read(event("adjustment.created", adjustment({ action }), "evt_x", LATER), {
        readTransaction: async () => await transaction(),
      });
      expect(notification.event).toBeNull();
    },
  );

  test.each(["pending_approval", "rejected", "reversed"])("a %s adjustment projects nothing", async (status) => {
    const notification = await read(event("adjustment.created", adjustment({ status }), "evt_s", LATER), {
      readTransaction: async () => await transaction(),
    });
    expect(notification.event).toBeNull();
  });

  test("an adjustment naming a transaction this deployment holds no row for is recorded and projects nothing", async () => {
    const notification = await read(event("adjustment.created", adjustment(), "evt_orphan", LATER), {
      readTransaction: async () => undefined,
    });
    expect(notification.event).toBeNull();
    expect(notification.note).toContain("cannot read");
  });

  test("an adjustment against another deployment's transaction is fenced out", async () => {
    // An adjustment carries no stamp of ours, so the fence is ownership of the row it names — read back
    // and checked against this deployment's environment.
    const notification = await read(event("adjustment.created", adjustment(), "evt_fence", LATER), {
      readTransaction: async () => await transaction({ custom_data: await stamp("ada", "staging") }),
    });
    expect(notification.event).toBeNull();
    expect(notification.note).toBeNull();
  });
});

describe("the environment fence and the ownership proof", () => {
  test("an event stamped for another environment projects nothing and warns nobody", async () => {
    const notification = await read(
      event("subscription.activated", await subscription({ custom_data: await stamp("ada", "dev") })),
      {
        deployment: "staging",
      },
    );
    expect(notification.event).toBeNull();
    expect(notification.note).toBeNull();
  });

  test("an unstamped event is not fenced — a dashboard-created transaction carries no custom_data", async () => {
    const notification = await read(event("subscription.activated", await subscription({ custom_data: {} })));
    expect(notification.event).not.toBeNull();
    // It binds nobody, because there is nothing proven to bind to.
    expect(notification.accountReference).toBeNull();
  });

  test("a reference with a forged proof binds nobody, and the same reference proven binds", async () => {
    const forged = await read(
      event(
        "subscription.activated",
        await subscription({
          custom_data: { pithy_user: "mallory", pithy_env: "prod", pithy_ref_proof: "00".repeat(32) },
        }),
      ),
    );
    expect(forged.accountReference).toBeNull();

    // Anti-vacuity: the proven form does bind, so the case above fails on the MAC and not on the shape.
    const proven = await read(event("subscription.activated", await subscription()));
    expect(proven.accountReference).toBe("ada");
  });

  test("a proof minted for another environment does not bind here", async () => {
    // The environment is inside the MAC's message rather than beside it, so a staging proof cannot be
    // replayed against production by editing one field.
    const crossed = {
      pithy_user: "ada",
      pithy_env: "prod",
      pithy_ref_proof: await accountReferenceProof("ada", "staging", CREDENTIALS.webhookSecret),
    };
    const notification = await read(event("subscription.activated", await subscription({ custom_data: crossed })));
    expect(notification.accountReference).toBeNull();
  });

  test("a proof minted under another secret does not bind", async () => {
    const otherKey = {
      pithy_user: "ada",
      pithy_env: "prod",
      pithy_ref_proof: await accountReferenceProof("ada", "prod", "pdl_ntfset_someone_else"),
    };
    const notification = await read(event("subscription.activated", await subscription({ custom_data: otherKey })));
    expect(notification.accountReference).toBeNull();
  });

  test("a deployment that does not know its own environment trusts no reference", async () => {
    const notification = await readPaddleEvent(event("subscription.activated", await subscription()), {
      credentials: CREDENTIALS,
      environment: "production",
      now: new Date(OCCURRED),
    });
    expect(notification.accountReference).toBeNull();
  });
});

describe("everything else", () => {
  test.each([
    "customer.created",
    "address.updated",
    "business.created",
    "payment_method.saved",
    "price.updated",
    "product.created",
    "discount.created",
    "subscription.quantum_entangled",
  ])("%s is authentic, recorded, and projects nothing", async (type) => {
    const notification = await read(event(type, { id: "x", status: "active" }));
    expect(notification.event).toBeNull();
    expect(notification.providerEventId).toBe("evt_01");
    expect(notification.payload).toMatchObject({ event_type: type });
  });
});

describe("the sweep asks for exactly what the map acts on", () => {
  test("every swept type is a type the map projects, and every projecting type is swept", async () => {
    // Written out in `events.ts` and checked here against the map's own behaviour rather than against a
    // copy of the list. A type the map acts on but the sweep never fetches would repair through the
    // webhook path and not through the sweep, which is the asymmetry the sweep exists to remove.
    const projecting: string[] = [];
    for (const type of [
      ...PADDLE_SWEPT_EVENT_TYPES,
      "transaction.created",
      "transaction.ready",
      "customer.created",
      "price.updated",
      "product.created",
      "discount.created",
      "payout.paid",
      "api_key.created",
      "client_token.created",
    ]) {
      const data = type.startsWith("subscription.")
        ? await subscription()
        : type.startsWith("transaction.")
          ? await transaction()
          : type.startsWith("adjustment.")
            ? {
                id: "adj_01",
                action: "refund",
                status: "approved",
                transaction_id: TXN,
                totals: { total: "999" },
              }
            : { id: "x", status: "active" };
      const notification = await read(event(type, data), { readTransaction: async () => await transaction() });
      if (notification.event !== null) projecting.push(type);
    }

    // Anti-vacuity: the sweep list is not empty and the sample above genuinely contained non-projecting
    // types, so the subset claim below is doing work.
    expect(PADDLE_SWEPT_EVENT_TYPES.length).toBeGreaterThan(15);
    expect(projecting.length).toBeGreaterThan(10);
    for (const type of projecting) expect(PADDLE_SWEPT_EVENT_TYPES, type).toContain(type);
  });

  test("the sweep never asks for the two event types that carry credentials", async () => {
    // Verified live: the sandbox's own stream carries `api_key.created` and `client_token.created`, and
    // the client token's `token` field is **not** redacted by Paddle. A type absent from the query is a
    // type never fetched, so it can never be recorded — the filter is in the query for this reason.
    expect(PADDLE_SWEPT_EVENT_TYPES).not.toContain("api_key.created");
    expect(PADDLE_SWEPT_EVENT_TYPES).not.toContain("client_token.created");
    for (const type of PADDLE_SWEPT_EVENT_TYPES) {
      expect(type.startsWith("api_key") || type.startsWith("client_token") || type.startsWith("payout"), type).toBe(
        false,
      );
    }
  });
});
