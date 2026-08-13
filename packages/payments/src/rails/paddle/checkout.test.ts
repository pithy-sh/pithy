// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { CheckoutSessionInput, PortalSessionInput } from "../contract";
import type { PaddleHttpFetch, PaddleHttpRequest } from "./api";
import { createPaddleCheckoutSession, type PaddleCheckoutOptions } from "./checkout";
import { createPaddleDiscount, listPaddleDiscounts, PADDLE_DISCOUNT_CODE } from "./discounts";
import { accountReferenceOf, PADDLE_CUSTOM_ACCOUNT, PADDLE_CUSTOM_ENV, PADDLE_CUSTOM_PROOF } from "./objects";
import { createPaddlePortalSession } from "./portal";
import { verifyPaddleTransaction } from "./verify";

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};
const PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";
const TXN = "txn_01hv8wptq8987qeep44cyrewp9";
const CUSTOMER = "ctm_01hv8wptq8987qeep44cyrewp9";
const NOW = new Date("2026-08-12T09:00:00Z");

const INPUT: CheckoutSessionInput = {
  providerProductId: PRICE,
  subscription: true,
  userId: "ada",
  successUrl: "https://acme.example/thanks",
};

interface Call {
  url: string;
  init?: PaddleHttpRequest;
}

/** A transport that answers each path with a body, and records every call. */
function stub(answers: Record<string, unknown>, status = 200): PaddleHttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const transport = (async (url: string, init?: PaddleHttpRequest) => {
    calls.push({ url, init });
    const key = Object.keys(answers).find((fragment) => url.includes(fragment));
    if (key === undefined) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: status < 400, status, text: async () => JSON.stringify({ data: answers[key] }) };
  }) as PaddleHttpFetch & { calls: Call[] };
  transport.calls = calls;
  return transport;
}

/** The transaction Paddle answers `POST /transactions` with. */
const CREATED = { id: TXN, status: "ready", created_at: NOW.toISOString(), items: [{ price: { id: PRICE } }] };

/** The body of the last call, parsed. */
function sent(transport: { calls: Call[] }): Record<string, unknown> {
  return JSON.parse(transport.calls.at(-1)?.init?.body ?? "{}") as Record<string, unknown>;
}

/** Run and hand back the `PithyError`, or fail loudly when nothing was thrown. */
async function refusal(run: () => Promise<unknown>): Promise<PithyError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected a refusal, got a pass");
}

function options(overrides: Partial<PaddleCheckoutOptions> = {}): PaddleCheckoutOptions {
  return {
    credentials: CREDENTIALS,
    environment: "sandbox",
    clientToken: "test_1234567890abcdefghij",
    checkout: "overlay",
    deployment: "prod",
    ...overrides,
  };
}

describe("createPaddleCheckoutSession", () => {
  test("overlay and inline return the transaction, because there is nowhere to navigate to", async () => {
    const transport = stub({ "/transactions": CREATED });
    const handoff = await createPaddleCheckoutSession(INPUT, options({ transport }));
    expect(handoff).toEqual({
      kind: "paddle",
      transactionId: TXN,
      clientToken: "test_1234567890abcdefghij",
      environment: "sandbox",
      displayMode: "overlay",
      // From config, and it has to cross: Paddle.js takes it as `settings.successUrl` at the moment the
      // overlay opens, which is in the browser. Config said of this field that it was "used as
      // `settings.successUrl` for Paddle.js" while nothing passed it, so in two of the three modes the
      // adopter's return page was unreachable.
      successUrl: INPUT.successUrl,
    });

    const inline = stub({ "/transactions": CREATED });
    const second = await createPaddleCheckoutSession(INPUT, options({ transport: inline, checkout: "inline" }));
    expect(second).toMatchObject({ kind: "paddle", displayMode: "inline", successUrl: INPUT.successUrl });
  });

  test("the success URL is the one the route resolved from config, not one derived here", async () => {
    // Two different URLs through the same rail. A hardcoded one, or one built from the transaction, would
    // pass the case above and fail this — and would be a paying customer landing on the wrong page, or on
    // production's page from staging.
    const transport = stub({ "/transactions": CREATED });
    const elsewhere = { ...INPUT, successUrl: "https://staging.acme.example/welcome?x=1" };
    const handoff = await createPaddleCheckoutSession(elsewhere, options({ transport }));
    expect(handoff).toMatchObject({ successUrl: "https://staging.acme.example/welcome?x=1" });
  });

  test("hosted returns the redirect member, so Stripe and Lemon Squeezy's shape is unchanged", async () => {
    const transport = stub({
      "/transactions": { ...CREATED, checkout: { url: "https://sandbox-pay.paddle.io/hsc_01" } },
    });
    const handoff = await createPaddleCheckoutSession(INPUT, options({ transport, checkout: "hosted" }));
    expect(handoff).toEqual({ kind: "redirect", url: "https://sandbox-pay.paddle.io/hsc_01" });
  });

  test("hosted with no default payment link names the dashboard setting rather than sending nowhere", async () => {
    // Paddle returns a null `checkout.url` when the account has no default payment link. Verified live:
    // the same misconfiguration makes `POST /transactions` refuse outright, account-wide.
    const transport = stub({ "/transactions": { ...CREATED, checkout: { url: null } } });
    const thrown = await refusal(() => createPaddleCheckoutSession(INPUT, options({ transport, checkout: "hosted" })));
    expect(thrown.payload.code).toBe("payments/rail_not_configured");
    expect(thrown.payload.detail).toContain("default payment link");
  });

  test("the price comes from the catalog and the purchaser from the seam — neither from a body", async () => {
    const transport = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession({ ...INPUT, providerAccountId: CUSTOMER }, options({ transport }));
    const body = sent(transport);
    expect(body.items).toEqual([{ price_id: PRICE, quantity: 1 }]);
    expect(body.customer_id).toBe(CUSTOMER);
    // Automatic, always: manual collection raises an invoice and waits, which this rail does not sell.
    expect(body.collection_mode).toBe("automatic");
    // No amount, no quantity above one, no proration. A checkout that could name an amount would be one a
    // client could name an amount on.
    expect(Object.keys(body).sort()).toEqual(["collection_mode", "custom_data", "customer_id", "items"]);
  });

  test("the stamped keys are the keys the rail reads back — the round trip, pinned", async () => {
    // Sending `pithyUser` and reading `pithy_user` silently never matches, and the binding never happens.
    // Both sides read the same constants, and this is what proves they meet.
    const transport = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport }));
    const custom = sent(transport).custom_data as Record<string, string>;
    expect(Object.keys(custom).sort()).toEqual([PADDLE_CUSTOM_ACCOUNT, PADDLE_CUSTOM_ENV, PADDLE_CUSTOM_PROOF].sort());

    // The reader accepts exactly what the writer wrote, with no edit in between.
    expect(await accountReferenceOf(custom, "prod", CREDENTIALS.webhookSecret)).toBe("ada");
    // And refuses it for another deployment, because the environment is inside the MAC.
    expect(await accountReferenceOf(custom, "staging", CREDENTIALS.webhookSecret)).toBeNull();
  });

  test("a deployment that does not know its own environment stamps no proof and binds nobody", async () => {
    const transport = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport, deployment: undefined }));
    const custom = sent(transport).custom_data as Record<string, string>;
    expect(Object.keys(custom)).toEqual([PADDLE_CUSTOM_ACCOUNT]);
    expect(await accountReferenceOf(custom, undefined, CREDENTIALS.webhookSecret)).toBeNull();
  });

  test("sends an idempotency key derived from the buyer, the price and the deployment", async () => {
    // A double-submitted buy button must create one transaction. Enforced by Paddle, which is the only
    // place it can be: the two requests may land on different isolates.
    const first = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport: first }));
    const key = first.calls.at(-1)?.init?.headers?.["paddle-idempotency-key"];
    expect(key).toBeDefined();

    // The same click retried carries the same key…
    const again = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport: again }));
    expect(again.calls.at(-1)?.init?.headers?.["paddle-idempotency-key"]).toBe(key);

    // …and a different buyer, or a different price, does not — or one would suppress the other's checkout.
    const other = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession({ ...INPUT, userId: "bob" }, options({ transport: other }));
    expect(other.calls.at(-1)?.init?.headers?.["paddle-idempotency-key"]).not.toBe(key);

    const otherPrice = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession({ ...INPUT, providerProductId: "pri_other" }, options({ transport: otherPrice }));
    expect(otherPrice.calls.at(-1)?.init?.headers?.["paddle-idempotency-key"]).not.toBe(key);

    // **And a discount code changes it.** A buyer who abandons a checkout, types a code and starts again
    // must not be handed back the transaction created before the code — that is an idempotency key doing
    // exactly what it was told and charging full price.
    const discounted = stub({ "/discounts": [{ id: "dsc_01" }], "/transactions": CREATED });
    await createPaddleCheckoutSession({ ...INPUT, discountCode: "PITHYTEST25" }, options({ transport: discounted }));
    expect(discounted.calls.at(-1)?.init?.headers?.["paddle-idempotency-key"]).not.toBe(key);
  });

  test("pins Paddle-Version, so a future default at Paddle cannot reshape what this parses", async () => {
    const transport = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport }));
    expect(transport.calls.at(-1)?.init?.headers?.["paddle-version"]).toBe("1");
    expect(transport.calls.at(-1)?.url).toContain("sandbox-api.paddle.com");
  });

  test("production reaches the production host and sandbox the sandbox one", async () => {
    const transport = stub({ "/transactions": CREATED });
    await createPaddleCheckoutSession(INPUT, options({ transport, environment: "production" }));
    expect(transport.calls.at(-1)?.url).toContain("https://api.paddle.com");
    expect(transport.calls.at(-1)?.url).not.toContain("sandbox");
  });
});

describe("a discount code at checkout", () => {
  test("resolves the code to an id and passes it unchanged — nothing here computes a price", async () => {
    const transport = stub({ "/discounts": [{ id: "dsc_01" }], "/transactions": CREATED });
    await createPaddleCheckoutSession({ ...INPUT, discountCode: "PITHYTEST25" }, options({ transport }));
    // Resolved first, active-only, in the query rather than by reading `expires_at` here.
    expect(transport.calls[0]?.url).toContain("code=PITHYTEST25");
    expect(transport.calls[0]?.url).toContain("status=active");
    expect(sent(transport).discount_id).toBe("dsc_01");
    // No computed amount anywhere in what was sent.
    expect(Object.keys(sent(transport))).not.toContain("amount");
  });

  test("an unresolvable code is `payments/discount_invalid` naming the code, not a payment failure", async () => {
    // A customer told "something went wrong" at checkout concludes their card was declined.
    const transport = stub({ "/discounts": [], "/transactions": CREATED });
    const thrown = await refusal(() =>
      createPaddleCheckoutSession({ ...INPUT, discountCode: "NOPE" }, options({ transport })),
    );
    expect(thrown.payload.code).toBe("payments/discount_invalid");
    expect(thrown.payload.message).toContain("NOPE");
    // And no transaction was created: the refusal happens before anything exists to be paid for.
    expect(transport.calls).toHaveLength(1);
  });

  test("a code Paddle's charset refuses is a refused code, not an unavailable rail", async () => {
    // Verified live: `PITHY_RECON-25` came back as a bare 400 "Invalid request." Left alone that surfaces
    // as `rail_not_configured`, which tells a customer this payment method is unavailable.
    const transport = stub({ "/discounts": {} }, 400);
    const thrown = await refusal(() =>
      createPaddleCheckoutSession({ ...INPUT, discountCode: "PITHY_RECON" }, options({ transport })),
    );
    expect(thrown.payload.code).toBe("payments/discount_invalid");
  });

  test("applying a code needs no ability to create one — the two are separate calls entirely", async () => {
    // The apply half must work against codes minted by hand in the Paddle dashboard.
    const transport = stub({ "/discounts": [{ id: "dsc_byhand" }], "/transactions": CREATED });
    const handoff = await createPaddleCheckoutSession({ ...INPUT, discountCode: "BYHAND" }, options({ transport }));
    expect(handoff).toMatchObject({ kind: "paddle" });
    // Only a GET was made against /discounts. Nothing was created.
    expect(transport.calls[0]?.init?.method).toBe("GET");
  });
});

describe("createPaddleDiscount", () => {
  const base = { credentials: CREDENTIALS, environment: "sandbox" as const };
  const created = (overrides: Record<string, unknown> = {}) => ({
    id: "dsc_01kzxjkfrtx4whvydxzyp2sdyv",
    code: "PITHYRECON244894",
    type: "percentage",
    amount: "10",
    ...overrides,
  });

  test("counts billing periods, not months — pinned on an *annual* plan", async () => {
    // The whole point of the normalized shape. On a monthly plan the two coincide; on an annual one, `12`
    // means a year on Stripe and twelve years here. Round-tripped live: `recur: true` with
    // `maximum_recurring_intervals: 12` came back as 12 on a percentage discount.
    const transport = stub({ "/discounts": created() });
    await createPaddleDiscount(
      {
        code: "PITHYRECON244894",
        amount: { kind: "percent", percent: 10 },
        duration: { kind: "repeating", billingPeriods: 12 },
        billingInterval: "year",
      },
      { ...base, transport },
    );
    const body = sent(transport);
    expect(body.recur).toBe(true);
    // Twelve, unconverted. A rail that multiplied by twelve here would offer a decade of a discount.
    expect(body.maximum_recurring_intervals).toBe(12);
  });

  test("`once` and `forever` map onto recur, and forever names no interval count", async () => {
    const once = stub({ "/discounts": created({ code: "ONCE" }) });
    await createPaddleDiscount(
      { code: "ONCE", amount: { kind: "percent", percent: 50 }, duration: { kind: "once" } },
      { ...base, transport: once },
    );
    expect(sent(once).recur).toBe(false);
    expect(sent(once).maximum_recurring_intervals).toBeUndefined();

    const forever = stub({ "/discounts": created({ code: "FOREVER" }) });
    await createPaddleDiscount(
      { code: "FOREVER", amount: { kind: "percent", percent: 50 }, duration: { kind: "forever" } },
      { ...base, transport: forever },
    );
    expect(sent(forever).recur).toBe(true);
    expect(sent(forever).maximum_recurring_intervals).toBeUndefined();
  });

  test("`redeemableUntil` maps to expires_at, which stops redemption and not an existing rate", async () => {
    const transport = stub({ "/discounts": created({ code: "SUMMER" }) });
    await createPaddleDiscount(
      {
        code: "SUMMER",
        amount: { kind: "percent", percent: 25 },
        duration: { kind: "forever" },
        redeemableUntil: new Date("2026-09-01T00:00:00Z"),
        maxRedemptions: 100,
      },
      { ...base, transport },
    );
    expect(sent(transport).expires_at).toBe("2026-09-01T00:00:00.000Z");
    // Single use is enforced at Paddle, which is what stops a second redemption when a webhook never lands.
    expect(sent(transport).usage_limit).toBe(100);
  });

  test("a fixed amount travels in uppercase, unscaled, as a string", async () => {
    // Paddle's `currency_code` is UPPERCASE where this package's is lowercase, and amounts are always in
    // the lowest denomination — ¥725 is "725", not "72500", confirmed live. Nothing here multiplies.
    const transport = stub({ "/discounts": created({ code: "FLAT", type: "flat" }) });
    await createPaddleDiscount(
      { code: "FLAT", amount: { kind: "fixed", amountMinor: 2500, currency: "usd" }, duration: { kind: "once" } },
      { ...base, transport },
    );
    expect(sent(transport)).toMatchObject({ type: "flat", amount: "2500", currency_code: "USD" });
  });

  test("a fixed amount in a currency the catalog does not price in is refused at creation, naming both", async () => {
    const transport = stub({ "/discounts": created() });
    const thrown = await refusal(() =>
      createPaddleDiscount(
        { code: "EUROS", amount: { kind: "fixed", amountMinor: 500, currency: "eur" }, duration: { kind: "once" } },
        { ...base, storeCurrency: "usd", transport },
      ),
    );
    expect(thrown.payload.code).toBe("payments/discount_invalid");
    expect(thrown.payload.detail).toContain("EUR");
    expect(thrown.payload.detail).toContain("USD");
    // Refused before anything is sent — the adopter is still the one reading the error.
    expect(transport.calls).toHaveLength(0);
  });

  test("a code Paddle's charset refuses is refused here, with the reason Paddle will not give", async () => {
    // Live, `PITHY_RECON-25` earns a bare "Invalid request." with no field named. The shared
    // `DiscountCode` schema is deliberately wider — narrowing it would refuse codes the Stripe and Lemon
    // Squeezy rails accept today — so the refusal is this rail's and it says which characters.
    expect(PADDLE_DISCOUNT_CODE.test("PITHYTEST25")).toBe(true);
    expect(PADDLE_DISCOUNT_CODE.test("PITHY_RECON-25")).toBe(false);

    const transport = stub({ "/discounts": created() });
    const thrown = await refusal(() =>
      createPaddleDiscount(
        { code: "PITHY_RECON-25", amount: { kind: "percent", percent: 25 }, duration: { kind: "once" } },
        { ...base, transport },
      ),
    );
    expect(thrown.payload.code).toBe("payments/discount_invalid");
    expect(thrown.payload.action).toContain("no dashes and no underscores");
    expect(transport.calls).toHaveLength(0);
  });

  test("a discount with no code is applicable only by id", async () => {
    const transport = stub({ "/discounts": created({ code: "PADDLEGENERATED" }) });
    await createPaddleDiscount(
      { amount: { kind: "percent", percent: 5 }, duration: { kind: "once" } },
      { ...base, transport },
    );
    expect(sent(transport).enabled_for_checkout).toBe(false);
  });

  test("listDiscounts renders the store's own figures and never divides one", async () => {
    const transport = stub({
      "/discounts": [
        { id: "dsc_1", code: "PITHYTEST25", type: "flat", amount: "2500", currency_code: "USD", times_used: 3 },
        { id: "dsc_2", code: "TENOFF", type: "percentage", amount: "10", currency_code: null, times_used: 0 },
        // No code: applicable only by id, and a list of codes is what this returns.
        { id: "dsc_3", code: null, type: "percentage", amount: "5" },
      ],
    });
    expect(await listPaddleDiscounts({ ...base, transport })).toEqual([
      { code: "PITHYTEST25", providerDiscountId: "dsc_1", amount: "2500 usd", redemptions: 3 },
      { code: "TENOFF", providerDiscountId: "dsc_2", amount: "10%", redemptions: 0 },
    ]);
  });
});

describe("createPaddlePortalSession", () => {
  const SESSION = {
    id: "cpls_01",
    urls: {
      general: { overview: "https://sandbox-customer-portal.paddle.com/cpl_01?token=pga_x" },
      subscriptions: [
        {
          id: "sub_01",
          cancel_subscription: "https://sandbox-customer-portal.paddle.com/subscriptions/sub_01/cancel?token=pga_y",
          update_subscription_payment_method:
            "https://sandbox-customer-portal.paddle.com/subscriptions/sub_01/payment?token=pga_z",
        },
      ],
    },
  };

  const input: PortalSessionInput = { providerAccountId: CUSTOMER, subscriptionIds: ["sub_01"] };

  test("returns the overview and the caller's own per-subscription deep links", async () => {
    const transport = stub({ "/portal-sessions": SESSION });
    expect(
      await createPaddlePortalSession(input, { credentials: CREDENTIALS, environment: "sandbox", transport }),
    ).toEqual({
      url: SESSION.urls.general.overview,
      subscriptions: [
        {
          subscriptionId: "sub_01",
          cancel: SESSION.urls.subscriptions[0]?.cancel_subscription,
          updatePaymentMethod: SESSION.urls.subscriptions[0]?.update_subscription_payment_method,
        },
      ],
    });
    // The customer is a path segment resolved from the account map, and the ids come from the caller's own
    // rows. There is no field in this request anyone could point at somebody else's billing.
    expect(transport.calls[0]?.url).toContain(`/customers/${CUSTOMER}/portal-sessions`);
    expect(sent(transport)).toEqual({ subscription_ids: ["sub_01"] });
  });

  test("with no subscriptions it asks for the overview alone and omits the key", async () => {
    const transport = stub({ "/portal-sessions": { ...SESSION, urls: { general: SESSION.urls.general } } });
    const handoff = await createPaddlePortalSession(
      { providerAccountId: CUSTOMER },
      { credentials: CREDENTIALS, environment: "sandbox", transport },
    );
    // Omitted rather than empty: `undefined` reads as "this rail does not do deep links", `[]` as "it does
    // and this caller has none". A screen must be able to tell those apart.
    expect(handoff).toEqual({ url: SESSION.urls.general.overview });
    expect(sent(transport)).toEqual({});
  });

  test("asks for at most the 25 Paddle accepts", async () => {
    const transport = stub({ "/portal-sessions": SESSION });
    const many = Array.from({ length: 40 }, (_, index) => `sub_${index}`);
    await createPaddlePortalSession(
      { providerAccountId: CUSTOMER, subscriptionIds: many },
      { credentials: CREDENTIALS, environment: "sandbox", transport },
    );
    expect(sent(transport).subscription_ids as string[]).toHaveLength(25);
  });

  test("a session with no authenticated URLs names the permission rather than sending a buyer to a sign-in", async () => {
    const transport = stub({ "/portal-sessions": { id: "cpls_01", urls: {} } });
    const thrown = await refusal(() =>
      createPaddlePortalSession(input, { credentials: CREDENTIALS, environment: "sandbox", transport }),
    );
    expect(thrown.payload.detail).toContain("customer_portal_session.write");
  });
});

describe("verifyPaddleTransaction", () => {
  const base = { credentials: CREDENTIALS, environment: "sandbox" as const, deployment: "prod", now: NOW };

  /** A transaction as the API returns it, with a proof this deployment could have written. */
  async function transaction(userId: string | null): Promise<Record<string, unknown>> {
    const { accountReferenceProof } = await import("./objects");
    return {
      id: TXN,
      status: "completed",
      customer_id: CUSTOMER,
      subscription_id: null,
      items: [{ price: { id: PRICE } }],
      details: { totals: { grand_total: "999", currency_code: "USD" } },
      custom_data:
        userId === null
          ? {}
          : {
              pithy_user: userId,
              pithy_env: "prod",
              pithy_ref_proof: await accountReferenceProof(userId, "prod", CREDENTIALS.webhookSecret),
            },
      created_at: NOW.toISOString(),
    };
  }

  test("reads the transaction and reports the reference it can prove this server wrote", async () => {
    const transport = stub({ "/transactions/": await transaction("ada") });
    const verified = await verifyPaddleTransaction(TXN, { ...base, transport });
    expect(verified.accountReference).toBe("ada");
    expect(verified.providerAccountId).toBe(CUSTOMER);
    // The clock, not the transaction's timestamp: a verify is a read of the state now, and dating it
    // earlier would let a webhook that arrived first discard it.
    expect(verified.event.providerEventAt).toEqual(NOW);
  });

  test("refuses a transaction carrying a reference it cannot prove", async () => {
    // The whole security of the path. An unguessable id is not a credential — the stamp is.
    const transport = stub({
      "/transactions/": { ...(await transaction(null)), custom_data: { pithy_user: "mallory", pithy_env: "prod" } },
    });
    const thrown = await refusal(() => verifyPaddleTransaction(TXN, { ...base, transport }));
    expect(thrown.payload.code).toBe("payments/verification_failed");
    // And it does not echo the claimed owner back: a caller learning "this belongs to somebody else" has
    // learned that the id exists and is owned.
    expect(JSON.stringify(thrown.payload)).not.toContain("mallory");
  });

  test("refuses a transaction with no stamp at all", async () => {
    const transport = stub({ "/transactions/": await transaction(null) });
    expect((await refusal(() => verifyPaddleTransaction(TXN, { ...base, transport }))).payload.code).toBe(
      "payments/verification_failed",
    );
  });

  test("refuses a malformed id without paying for a round trip", async () => {
    const transport = stub({ "/transactions/": await transaction("ada") });
    const thrown = await refusal(() => verifyPaddleTransaction("sub_01", { ...base, transport }));
    expect(thrown.payload.code).toBe("payments/invalid_receipt");
    expect(transport.calls).toHaveLength(0);
  });

  test("refuses a transaction Paddle does not know", async () => {
    const transport = stub({});
    expect((await refusal(() => verifyPaddleTransaction(TXN, { ...base, transport }))).payload.code).toBe(
      "payments/verification_failed",
    );
  });

  test("a deployment that does not know its own environment accepts nothing", async () => {
    // The safe direction: an unbound purchase is repairable from the trail; an unauthenticated write into
    // the account map is not, because `linkProviderAccount` never rebinds.
    const transport = stub({ "/transactions/": await transaction("ada") });
    expect(
      (await refusal(() => verifyPaddleTransaction(TXN, { ...base, deployment: undefined, transport }))).payload.code,
    ).toBe("payments/verification_failed");
  });
});
