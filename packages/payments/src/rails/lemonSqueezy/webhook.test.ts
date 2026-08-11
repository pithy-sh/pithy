// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { VerifiedNotification } from "../contract";
import type { LemonSqueezyHttpFetch } from "./api";
import {
  ACCOUNT_REFERENCE,
  CUSTOMER_ID,
  INVOICE_ONE,
  INVOICE_TWO,
  invoiceDelivery,
  ORDER_ID,
  orderDelivery,
  SUBSCRIPTION_ID,
  subscriptionDelivery,
  subscriptionResponse,
  THIS_DEPLOYMENT,
  unknownDelivery,
  VARIANT_ID,
} from "./fixtures/events";
import { LEMON_SQUEEZY_CUSTOM_ACCOUNT, LEMON_SQUEEZY_CUSTOM_ENV } from "./objects";
import { signLemonSqueezyBody } from "./signature";
import { parseLemonSqueezyNotification } from "./webhook";

const CREDENTIALS: PaymentsLemonSqueezyCredentials = {
  apiKey: "ls_api_test",
  webhookSecret: "ls_whsec_test",
  storeId: "1",
};

/** A transport answering every subscription read with the same object, and recording what was asked. */
function reads(body: string = subscriptionResponse(), status = 200): LemonSqueezyHttpFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher: LemonSqueezyHttpFetch = (url) => {
    urls.push(url);
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
  };
  return Object.assign(fetcher, { urls });
}

/** Sign a body with the real secret and hand it to the rail, exactly as the guard would. */
async function parse(
  body: string,
  options: {
    deployment?: string;
    transport?: LemonSqueezyHttpFetch;
    sellsSubscription?: (variantId: string) => boolean;
  } = {},
): Promise<VerifiedNotification> {
  const headers = new Headers({ "x-signature": await signLemonSqueezyBody(body, CREDENTIALS.webhookSecret) });
  return await parseLemonSqueezyNotification(
    { body, headers },
    {
      credentials: CREDENTIALS,
      deployment: options.deployment ?? THIS_DEPLOYMENT,
      transport: options.transport ?? reads(),
      sellsSubscription: options.sellsSubscription,
    },
  );
}

describe("authenticity", () => {
  test("a forged signature is refused and nothing is read from the body", async () => {
    const body = orderDelivery("order_created");
    const headers = new Headers({ "x-signature": await signLemonSqueezyBody(body, "someone-elses-secret") });
    await expect(
      parseLemonSqueezyNotification({ body, headers }, { credentials: CREDENTIALS, transport: reads() }),
    ).rejects.toBeInstanceOf(PithyError);
  });

  test("nothing outside the signed body decides anything", async () => {
    // The HMAC covers the body and nothing else, so every header is attacker-controlled on a replayed
    // delivery. Lemon Squeezy also sends the event name in `X-Event-Name`; reading it would hand a replay
    // adversary the dedup key AND the choice of handler, from one captured authentic body.
    //
    // Both halves asserted: the composed providerEventId must not move, and a success must not be steered
    // into the refund branch that revokes a subscriber.
    const body = invoiceDelivery("subscription_payment_success");
    const signature = await signLemonSqueezyBody(body, CREDENTIALS.webhookSecret);

    const honest = await parseLemonSqueezyNotification(
      { body, headers: new Headers({ "x-signature": signature }) },
      { credentials: CREDENTIALS, deployment: THIS_DEPLOYMENT, transport: reads() },
    );
    const lied = await parseLemonSqueezyNotification(
      {
        body,
        headers: new Headers({ "x-signature": signature, "x-event-name": "subscription_payment_refunded" }),
      },
      { credentials: CREDENTIALS, deployment: THIS_DEPLOYMENT, transport: reads() },
    );

    expect(lied.providerEventId).toBe(honest.providerEventId);
    expect(lied.providerEventId).toContain("subscription_payment_success");
    expect(lied.event?.status).toBe("expired");
    // The refund branch is the one that revokes access. A header must never reach it.
    expect(lied.stateEvent ?? null).toBeNull();
  });

  test("an absent signature is refused", async () => {
    const body = orderDelivery("order_created");
    await expect(
      parseLemonSqueezyNotification({ body, headers: new Headers() }, { credentials: CREDENTIALS, transport: reads() }),
    ).rejects.toBeInstanceOf(PithyError);
  });
});

describe("subscription-domain events — the state row", () => {
  test.each([
    ["subscription_created", "active", "active"],
    ["subscription_updated", "active", "active"],
    ["subscription_cancelled", "cancelled", "canceled"],
    ["subscription_expired", "expired", "expired"],
    ["subscription_paused", "paused", "paused"],
    ["subscription_unpaused", "active", "active"],
  ])("%s maps a %s subscription to %s", async (eventName, lsStatus, expected) => {
    const notification = await parse(subscriptionDelivery(eventName, { status: lsStatus }));
    expect(notification.event).toMatchObject({
      rail: "lemonSqueezy",
      providerTransactionId: `subscription:${SUBSCRIPTION_ID}`,
      originalTransactionId: `subscription:${SUBSCRIPTION_ID}`,
      role: "state",
      status: expected,
      providerProductId: String(VARIANT_ID),
    });
  });

  test("a state row carries no money, because a subscription object is not a charge", async () => {
    const notification = await parse(subscriptionDelivery("subscription_created"));
    expect(notification.event).toMatchObject({ amountMinor: null, currency: null, role: "state" });
  });

  test("costs no round-trip — the subscription object is complete", async () => {
    const transport = reads();
    await parse(subscriptionDelivery("subscription_updated"), { transport });
    expect(transport.urls).toEqual([]);
  });

  test("the state row's clock is the subscription's own updated_at", async () => {
    const notification = await parse(
      subscriptionDelivery("subscription_updated", { updated_at: "2026-01-15T09:00:00.000000Z" }),
    );
    expect(notification.event?.providerEventAt).toEqual(new Date("2026-01-15T09:00:00.000Z"));
  });

  test("an unmapped status refuses rather than guessing", async () => {
    await expect(parse(subscriptionDelivery("subscription_updated", { status: "hibernating" }))).rejects.toBeInstanceOf(
      PithyError,
    );
  });
});

describe("invoice-domain events — the money row", () => {
  test("keys on the invoice, families on the subscription, and credits as a charge", async () => {
    const notification = await parse(invoiceDelivery("subscription_payment_success"));
    expect(notification.event).toMatchObject({
      providerTransactionId: `subscription_invoice:${INVOICE_ONE}`,
      originalTransactionId: `subscription:${SUBSCRIPTION_ID}`,
      role: "charge",
      status: "expired",
      amountMinor: 999,
      currency: "USD",
      providerProductId: String(VARIANT_ID),
    });
  });

  test("two consecutive renewals are two rows, which is what makes a grants clause credit twice", async () => {
    const first = await parse(invoiceDelivery("subscription_payment_success", INVOICE_ONE));
    const second = await parse(invoiceDelivery("subscription_payment_success", INVOICE_TWO));

    expect(first.event?.providerTransactionId).toBe(`subscription_invoice:${INVOICE_ONE}`);
    expect(second.event?.providerTransactionId).toBe(`subscription_invoice:${INVOICE_TWO}`);
    expect(first.event?.providerTransactionId).not.toBe(second.event?.providerTransactionId);
    // Both are charges, and both name the same family. Two rows, two purchase ids, two grant refs.
    expect([first.event?.role, second.event?.role]).toEqual(["charge", "charge"]);
    expect(first.event?.originalTransactionId).toBe(second.event?.originalTransactionId);
  });

  test("reads the subscription for the variant, because the invoice does not carry one", async () => {
    const transport = reads();
    await parse(invoiceDelivery("subscription_payment_success"), { transport });
    expect(transport.urls).toHaveLength(1);
    expect(transport.urls[0]).toContain(`/subscriptions/${SUBSCRIPTION_ID}`);
  });

  test("an invoice event never moves the subscription's watermark, because it addresses another row", async () => {
    // The defect this design exists to prevent. The invoice's clock and the subscription's clock are
    // different clocks; they can only disorder if they meet on one row, and these keys cannot collide.
    const invoiceEvent = await parse(invoiceDelivery("subscription_payment_success"));
    const stateEvent = await parse(subscriptionDelivery("subscription_updated"));
    expect(invoiceEvent.event?.providerTransactionId).not.toBe(stateEvent.event?.providerTransactionId);
  });

  test.each([
    ["subscription_payment_failed", { status: "failed" }, "never_paid"],
    ["subscription_payment_recovered", { status: "paid" }, "expired"],
  ])("%s maps to %s", async (eventName, overrides, expected) => {
    const notification = await parse(invoiceDelivery(eventName, INVOICE_ONE, overrides));
    expect(notification.event?.status).toBe(expected);
  });

  test("an unresolvable subscription is recorded with a note rather than dropped", async () => {
    const notification = await parse(invoiceDelivery("subscription_payment_success"), {
      transport: reads("", 404),
    });
    expect(notification.event).toBeNull();
    expect(notification.note).toContain(SUBSCRIPTION_ID);
  });
});

describe("a refund nobody in this app asked for", () => {
  test("revokes the entitlement it paid for, as well as marking the money refunded", async () => {
    // Lemon Squeezy is merchant of record: it refunds on its own, for a chargeback or a tax dispute, with
    // no local write preceding it. The money row goes refunded so the ledger claws back; the state row is
    // revoked so the buyer stops holding the feature.
    const notification = await parse(
      invoiceDelivery("subscription_payment_refunded", INVOICE_ONE, {
        refunded: true,
        refunded_at: "2026-02-11T12:00:00.000000Z",
        updated_at: "2026-02-11T12:00:00.000000Z",
      }),
    );

    expect(notification.event).toMatchObject({
      providerTransactionId: `subscription_invoice:${INVOICE_ONE}`,
      role: "charge",
      status: "refunded",
    });
    expect(notification.stateEvent).toMatchObject({
      providerTransactionId: `subscription:${SUBSCRIPTION_ID}`,
      role: "state",
      status: "revoked",
    });
  });

  test("the revocation is dated by the refund, not by the subscription's stale updated_at", async () => {
    // The subscription object was last touched before the refund, so its own clock is older than the row
    // it is trying to move — the monotonic rule would discard the revocation entirely.
    const notification = await parse(
      invoiceDelivery("subscription_payment_refunded", INVOICE_ONE, {
        refunded: true,
        updated_at: "2026-02-11T12:00:00.000000Z",
      }),
      { transport: reads(subscriptionResponse({ updated_at: "2026-01-01T10:00:00.000000Z" })) },
    );
    expect(notification.stateEvent?.providerEventAt).toEqual(new Date("2026-02-11T12:00:00.000Z"));
  });

  test("a payment success carries no state event — only a refund changes the standing", async () => {
    const notification = await parse(invoiceDelivery("subscription_payment_success"));
    expect(notification.stateEvent ?? null).toBeNull();
  });
});

describe("order-domain events", () => {
  test("order_created is one row, money and state together", async () => {
    const notification = await parse(orderDelivery("order_created"));
    expect(notification.event).toMatchObject({
      providerTransactionId: `order:${ORDER_ID}`,
      originalTransactionId: null,
      role: "charge",
      status: "active",
      amountMinor: 4900,
    });
  });

  test("order_refunded revokes it", async () => {
    const notification = await parse(
      orderDelivery("order_refunded", { refunded: true, refunded_at: "2026-03-05T09:00:00.000000Z" }),
    );
    expect(notification.event).toMatchObject({ status: "refunded" });
    expect(notification.event?.revokedAt).toEqual(new Date("2026-03-05T09:00:00.000Z"));
  });

  test("the order that started a subscription is not a second payment", async () => {
    // A payment received creates a charge row, and one payment must create exactly one. Lemon Squeezy
    // raises an Order for a subscription purchase AND a subscription invoice for every period including the
    // first — the same money, reported twice. Projecting both credits one period twice, and the order's row
    // would grant forever besides: an order carries no expiry, so a never-expiring `active` row outranks
    // the subscription's state row even after a cancellation.
    const notification = await parse(orderDelivery("order_created"), {
      sellsSubscription: () => true,
    });
    expect(notification.event).toBeNull();
    // Ordinary traffic for a subscription sale, so no audit warning.
    expect(notification.note ?? null).toBeNull();
    // The customer and the reference still land: this is the delivery carrying what checkout stamped, and
    // the subscription's own events arrive without one.
    expect(notification.providerAccountId).toBe(String(CUSTOMER_ID));
    expect(notification.accountReference).toBe(ACCOUNT_REFERENCE);
  });

  test("a genuine one-off order is still a payment", async () => {
    const notification = await parse(orderDelivery("order_created"), { sellsSubscription: () => false });
    expect(notification.event).toMatchObject({ role: "charge", status: "active", amountMinor: 4900 });
    expect(notification.event?.expiresAt ?? null).toBeNull();
  });

  test("an order whose money never arrived grants nothing, whatever the catalog says", async () => {
    // `in_grace` grants by policy, and an order has no expiry — so a pending order mapped to grace was
    // permanent free access for money that never cleared.
    const notification = await parse(orderDelivery("order_created", { status: "pending" }), {
      sellsSubscription: () => false,
    });
    expect(notification.event?.status).toBe("on_hold");
  });

  test("an order id and an invoice id of the same number are different rows", async () => {
    // Lemon Squeezy numbers each object type from one, so a bare id would fuse them under
    // UNIQUE (rail, providerTransactionId) — one buyer's refund landing on another's subscription.
    const asOrder = await parse(orderDelivery("order_created"));
    const asInvoice = await parse(invoiceDelivery("subscription_payment_success", ORDER_ID));
    expect(asOrder.event?.providerTransactionId).not.toBe(asInvoice.event?.providerTransactionId);
  });
});

describe("the shared-store fence", () => {
  test("an event stamped for another deployment projects nothing, warns nothing, and is not an error", async () => {
    const notification = await parse(subscriptionDelivery("subscription_created", {}, { deployment: "dev" }), {
      deployment: "prod",
    });
    expect(notification.event).toBeNull();
    expect(notification.providerAccountId).toBeNull();
    expect(notification.accountReference).toBeNull();
    // Null and not a string: a note routes the route into an audit warning, and another deployment's
    // ordinary traffic is not a thing to warn an operator about.
    expect(notification.note ?? null).toBeNull();
  });

  test("our own deployment's event is projected", async () => {
    const notification = await parse(subscriptionDelivery("subscription_created", {}, { deployment: "prod" }), {
      deployment: "prod",
    });
    expect(notification.event).not.toBeNull();
  });

  test("an unstamped event is not fenced — a storefront order still sold something", async () => {
    const notification = await parse(orderDelivery("order_created", {}, { stamped: false }), {
      deployment: "prod",
    });
    expect(notification.event).not.toBeNull();
    expect(notification.accountReference).toBeNull();
  });

  test("an account reference without our own env stamp beside it is not honoured", async () => {
    // Lemon Squeezy's public storefront buy links accept `checkout[custom][...]` parameters, so a stranger
    // can put any string in `custom_data` and the webhook echoes it exactly as one of ours would. The route
    // writes the provider-account link from `accountReference`, and `linkProviderAccount` never rebinds —
    // so honouring an unstamped one is an unauthenticated, permanent write into the account map.
    const forged = await parse(subscriptionDelivery("subscription_created", {}, { stamped: false }), {
      deployment: "prod",
    });
    expect(forged.accountReference).toBeNull();
    // The purchase still projects. It simply arrives unbound, which the trail makes repairable.
    expect(forged.event).not.toBeNull();
  });

  test("an account reference stamped for another deployment is not honoured either", async () => {
    // Fenced out entirely, so it never reaches the account map by any path.
    const other = await parse(subscriptionDelivery("subscription_created", {}, { deployment: "dev" }), {
      deployment: "prod",
    });
    expect(other.accountReference).toBeNull();
  });

  test("a deployment that does not know its own environment trusts no reference at all", async () => {
    // It cannot tell its own checkout's stamp from a stranger's, so it declines to bind. The cost is a
    // purchase that lands unbound; the other direction is a permanent write nothing undoes.
    const body = subscriptionDelivery("subscription_created");
    const headers = new Headers({ "x-signature": await signLemonSqueezyBody(body, CREDENTIALS.webhookSecret) });
    const notification = await parseLemonSqueezyNotification(
      { body, headers },
      { credentials: CREDENTIALS, transport: reads() },
    );
    expect(notification.accountReference).toBeNull();
  });

  test("a deployment that does not know its own name fences nothing", async () => {
    const body = subscriptionDelivery("subscription_created", {}, { deployment: "dev" });
    const headers = new Headers({ "x-signature": await signLemonSqueezyBody(body, CREDENTIALS.webhookSecret) });
    const notification = await parseLemonSqueezyNotification(
      { body, headers },
      { credentials: CREDENTIALS, transport: reads() },
    );
    expect(notification.event).not.toBeNull();
  });
});

describe("ownership travels in custom_data", () => {
  test("the keys the checkout stamps are the keys the rail reads back", async () => {
    // Lemon Squeezy normalizes custom keys to snake_case before echoing them. Sending camelCase and
    // reading camelCase silently never matches, and the purchase arrives orphaned. Both sides read these
    // two constants, and this is the round trip that proves it.
    expect(LEMON_SQUEEZY_CUSTOM_ACCOUNT).toBe(LEMON_SQUEEZY_CUSTOM_ACCOUNT.toLowerCase());
    expect(LEMON_SQUEEZY_CUSTOM_ENV).toBe(LEMON_SQUEEZY_CUSTOM_ENV.toLowerCase());
    expect(LEMON_SQUEEZY_CUSTOM_ACCOUNT).not.toMatch(/[A-Z]/);
    expect(LEMON_SQUEEZY_CUSTOM_ENV).not.toMatch(/[A-Z]/);

    const notification = await parse(subscriptionDelivery("subscription_created"));
    expect(notification.accountReference).toBe(ACCOUNT_REFERENCE);
  });

  test("the customer becomes the provider account, so a later webhook resolves a user", async () => {
    const notification = await parse(subscriptionDelivery("subscription_created"));
    expect(notification.providerAccountId).toBe(String(CUSTOMER_ID));
  });
});

describe("an event type Lemon Squeezy ships later", () => {
  test("is authentic, recorded, and projects nothing — no throw, no 5xx", async () => {
    const notification = await parse(unknownDelivery());
    expect(notification.event).toBeNull();
    expect(notification.note ?? null).toBeNull();
    expect(notification.payload).toBeTypeOf("object");
    expect(notification.providerEventId).toContain("license_key_created");
  });
});

describe("test mode", () => {
  test("a test-mode transaction is a sandbox purchase, which never grants in production", async () => {
    const notification = await parse(subscriptionDelivery("subscription_created", { test_mode: true }));
    expect(notification.event?.environment).toBe("sandbox");
  });

  test("only an object Lemon Squeezy states is live is production", async () => {
    const live = await parse(subscriptionDelivery("subscription_created", { test_mode: false }));
    expect(live.event?.environment).toBe("production");

    // An absent flag lands on sandbox: treating sandbox as production hands out real entitlements for test
    // transactions, and treating production as sandbox only loses a purchase reconciliation repairs.
    const unstated = await parse(subscriptionDelivery("subscription_created", { test_mode: undefined }));
    expect(unstated.event?.environment).toBe("sandbox");
  });
});

describe("the event id", () => {
  test("is stable across redeliveries of one event, which is how the guard recognizes a replay", async () => {
    const body = invoiceDelivery("subscription_payment_success");
    const first = await parse(body);
    const second = await parse(body);
    expect(first.providerEventId).toBe(second.providerEventId);
  });

  test("differs for two genuinely different events about one object", async () => {
    const created = await parse(subscriptionDelivery("subscription_created"));
    const updated = await parse(subscriptionDelivery("subscription_updated"));
    expect(created.providerEventId).not.toBe(updated.providerEventId);
  });

  test("differs for two events of the SAME type about one object", async () => {
    // The one that matters, and the one an event-name-plus-object-id key gets wrong. `subscription_updated`
    // fires on every renewal, plan change, pause and status move for one subscription. If they shared an id
    // the guard would project the first and answer every later one 200/duplicate without reprojecting — so
    // a subscriber's cancellation would be dropped and they would keep paid access forever.
    const renewal = await parse(
      subscriptionDelivery("subscription_updated", { updated_at: "2026-02-01T10:00:00.000000Z" }),
    );
    const cancellation = await parse(
      subscriptionDelivery("subscription_updated", {
        status: "cancelled",
        updated_at: "2026-02-10T08:00:00.000000Z",
      }),
    );
    expect(renewal.providerEventId).not.toBe(cancellation.providerEventId);
  });

  test("still collides for a redelivery of one event, which is how a retry is recognized", async () => {
    // The other half. A store retries at-least-once, and a redelivery must be recognized rather than
    // reprojected — so the id may not carry anything that moves between attempts.
    const body = subscriptionDelivery("subscription_updated");
    const first = await parse(body);
    const second = await parse(body);
    expect(first.providerEventId).toBe(second.providerEventId);
  });
});
