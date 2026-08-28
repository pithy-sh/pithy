// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { PaymentsPurchase } from "../../data/purchase";
import { RENDER_FALLBACK_LOCALE, renderMoney } from "../../data/renderMoney";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { PaddleHttpFetch, PaddleHttpRequest } from "./api";
import {
  cancelPaddleSubscription,
  changePaddlePlan,
  keepPaddleSubscription,
  previewPaddleChange,
  readPaddleStanding,
} from "./subscription";

/**
 * The Paddle subscription rail, against the sandbox recordings of 2026-08-28 (#465).
 *
 * Every wire string below is verbatim from `sub_01m02kntv7bhw3sxdy5kyj93kt` — the signs, the
 * microseconds, and Paddle's uppercase `"USD"`. Nothing is retyped into a shape that would have been
 * convenient, because the whole value of these fixtures is that this package did not get to choose them.
 *
 * The transport is stubbed and asserts on what was *sent*: the verb, the path, and the body. That is
 * where three of this rail's obligations live and none of them is visible in a return value — a request
 * that rebuilds the items array wrongly, or picks the wrong proration mode, or is issued at all when it
 * should not have been, produces a perfectly well-formed answer.
 */

const CREDENTIALS: PaymentsPaddleCredentials = {
  apiKey: "pdl_sdbx_apikey_01hv8wptq8987qeep44cyrewp9_suiteonly",
  webhookSecret: "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly",
};

const SUB = "sub_01m02kntv7bhw3sxdy5kyj93kt";
/** Solo, $6/mo. */
const SOLO = "pri_01kzvyz9e21z9vbhd7xqq3csyh";
/** Team, $110/mo. */
const TEAM = "pri_01kzvyz9khsdy36z10wb8bgmq4";
/** The instant every recording shares: the end of the period, which a screen prints as "15 Sep". */
const PERIOD_END = "2026-09-15T11:42:21.789736Z";

/** One outbound call, as the rail made it. */
interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** What the stub answers: a Paddle `data` envelope, or a refusal. */
type Answer = { data: unknown } | { status: number; body?: string };

/** What each endpoint answers. An endpoint with no entry here is one the rail must not reach. */
interface Routes {
  subscription?: unknown;
  prices?: Readonly<Record<string, unknown>>;
  preview?: unknown;
  update?: unknown;
  cancel?: unknown;
  refusal?: { on: "preview" | "update" | "cancel" | "subscription"; status: number; body?: string };
}

/**
 * A transport that records every call and answers from `routes`.
 *
 * **An unrouted call throws rather than answering an empty body.** Half these tests assert that a call
 * was *not* made, and a stub that quietly answers everything turns "the rail did not write" into "the
 * rail wrote and the assertion looked elsewhere".
 */
function paddle(routes: Routes): PaddleHttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const transport = (async (url: string, init?: PaddleHttpRequest) => {
    const method = init?.method ?? "GET";
    const call: Call = {
      url,
      method,
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
    };
    calls.push(call);
    const answer = route(routes, call);
    if ("data" in answer) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: answer.data }) };
    }
    return { ok: false, status: answer.status, text: async () => answer.body ?? "{}" };
  }) as PaddleHttpFetch & { calls: Call[] };
  transport.calls = calls;
  return transport;
}

function route(routes: Routes, call: Call): Answer {
  const path = call.url.replace(/^https:\/\/[^/]+/, "").split("?")[0] ?? "";
  const refuse = (which: Routes["refusal"] extends undefined ? never : NonNullable<Routes["refusal"]>["on"]) =>
    routes.refusal?.on === which ? { status: routes.refusal.status, body: routes.refusal.body } : undefined;

  if (call.method === "GET" && path === `/subscriptions/${SUB}`) {
    return refuse("subscription") ?? need(routes.subscription, "the subscription read");
  }
  if (call.method === "GET" && path.startsWith("/prices/")) {
    const id = path.slice("/prices/".length);
    const price = routes.prices?.[id];
    if (price === undefined) throw new Error(`the rail read an unrouted price: ${id}`);
    return { data: price };
  }
  if (call.method === "PATCH" && path === `/subscriptions/${SUB}/preview`) {
    return refuse("preview") ?? need(routes.preview, "the preview");
  }
  if (call.method === "PATCH" && path === `/subscriptions/${SUB}`) {
    return refuse("update") ?? need(routes.update, "the update");
  }
  if (call.method === "POST" && path === `/subscriptions/${SUB}/cancel`) {
    return refuse("cancel") ?? need(routes.cancel, "the cancel");
  }
  throw new Error(`the rail made a call this test did not route: ${call.method} ${path}`);
}

function need(value: unknown, what: string): Answer {
  if (value === undefined) throw new Error(`the rail reached for ${what}, which this case did not expect`);
  return { data: value };
}

const options = (transport: PaddleHttpFetch) => ({
  credentials: CREDENTIALS,
  environment: "sandbox" as const,
  transport,
});

/** Every call that changes something at Paddle. The no-op cases assert this is empty. */
const writes = (transport: { calls: Call[] }) => transport.calls.filter((call) => call.method !== "GET");

/** A stored purchase naming this subscription — the only reference any verb takes. */
const purchase = (overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchase => ({
  id: "11111111-1111-4111-8111-111111111111",
  subjectType: "user",
  subjectId: "ada",
  rail: "paddle",
  role: "state",
  providerTransactionId: SUB,
  productId: "team_monthly",
  providerProductId: TEAM,
  type: "subscription",
  status: "active",
  environment: "sandbox",
  purchasedAt: new Date("2026-08-15T11:42:21.789Z"),
  expiresAt: new Date(PERIOD_END),
  revokedAt: null,
  resumesAt: null,
  originalTransactionId: SUB,
  amountMinor: 11000,
  currency: "usd",
  providerEventAt: new Date("2026-08-15T11:42:21.789Z"),
  payload: {},
  createdAt: new Date("2026-08-15T11:42:21.789Z"),
  updatedAt: new Date("2026-08-15T11:42:21.789Z"),
  ...overrides,
});

/** How one line differs from the ordinary one. `null` means Paddle stated the field at all. */
interface LineTweaks {
  /** How many. `null` states none, which is the case the rail refuses rather than guessing. */
  quantity?: number | null;
  /** The billing cycle. `null` states none. */
  cycle?: { interval: string; frequency: number } | null;
}

/**
 * One priced line, built rather than mutated.
 *
 * Every awkward fixture below is a line that differs in one field, and reaching into a built object to
 * change it needs a non-null assertion on an index — which reads as an assertion about the fixture and is
 * really an assertion about the builder.
 */
function line(priceId: string, unitAmount: string, tweaks: LineTweaks = {}): Record<string, unknown> {
  const item: Record<string, unknown> = {
    price: {
      id: priceId,
      unit_price: { amount: unitAmount, currency_code: "USD" },
      ...(tweaks.cycle === null ? {} : { billing_cycle: tweaks.cycle ?? { interval: "month", frequency: 1 } }),
    },
    status: "active",
  };
  if (tweaks.quantity !== null) item.quantity = tweaks.quantity ?? 1;
  return item;
}

/** A subscription entity carrying one item at one price. Paddle's own casing throughout. */
function subscriptionOn(
  priceId: string,
  unitAmount: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: SUB,
    status: "active",
    customer_id: "ctm_01kzvyz9pithytestnotareal0",
    currency_code: "USD",
    items: [line(priceId, unitAmount)],
    current_billing_period: { starts_at: "2026-08-15T11:42:21.789736Z", ends_at: PERIOD_END },
    scheduled_change: null,
    next_billed_at: PERIOD_END,
    created_at: "2026-08-15T11:42:21.789736Z",
    updated_at: "2026-08-28T11:14:02.663Z",
    ...overrides,
  };
}

/** A price entity, as `GET /prices/{id}` answers one. */
const price = (id: string, amount: string, currency = "USD"): Record<string, unknown> => ({
  id,
  unit_price: { amount, currency_code: currency },
  billing_cycle: { interval: "month", frequency: 1 },
});

const PRICES = { [SOLO]: price(SOLO, "600"), [TEAM]: price(TEAM, "11000") };

/** A) the recorded preview of Solo → Team under `prorated_immediately`. The upgrade, verbatim. */
const UPGRADE_PREVIEW = {
  ...subscriptionOn(SOLO, "600"),
  update_summary: {
    credit: { amount: "-380", currency_code: "USD" },
    charge: { amount: "6962", currency_code: "USD" },
    result: { action: "charge", amount: "6582", currency_code: "USD" },
  },
  immediate_transaction: {
    details: {
      totals: {
        subtotal: "6045",
        tax: "537",
        discount: "0",
        total: "6582",
        grand_total: "6582",
        grand_total_tax: "537",
        fee: null,
        credit: "0",
        credit_to_balance: "0",
        balance: "6582",
        earnings: null,
        currency_code: "USD",
        exchange_rate: "1",
      },
    },
    billing_period: { starts_at: "2026-08-28T11:13:32.939Z", ends_at: PERIOD_END },
  },
  recurring_transaction_details: {
    totals: {
      subtotal: "11000",
      tax: "976",
      discount: "0",
      total: "11976",
      grand_total: "11976",
      grand_total_tax: "976",
      fee: null,
      credit: "0",
      credit_to_balance: "0",
      balance: "11976",
      earnings: null,
      currency_code: "USD",
      exchange_rate: "1",
    },
  },
};

/**
 * B′) the recorded preview of Team → Solo under `prorated_next_billing_period` — **the mode a downgrade
 * ships with**. Nothing settles today, 6558 is owed, and it lands on the invoice of 15 September.
 */
const DOWNGRADE_PREVIEW = {
  ...subscriptionOn(TEAM, "11000"),
  immediate_transaction: null,
  update_summary: {
    credit: { amount: "-6936" },
    charge: { amount: "378" },
    result: { action: "credit", amount: "6558", currency_code: "USD" },
  },
  recurring_transaction_details: {
    totals: {
      subtotal: "600",
      tax: "53",
      total: "653",
      grand_total: "653",
      credit_to_balance: "0",
      currency_code: "USD",
    },
  },
  next_transaction: {
    details: {
      totals: {
        subtotal: "-5424",
        tax: "-481",
        total: "-5905",
        grand_total: "0",
        credit_to_balance: "5905",
        currency_code: "USD",
      },
    },
    billing_period: { starts_at: PERIOD_END, ends_at: "2026-10-15T11:42:21.789736Z" },
  },
};

/** C) the subscription after `cancel({ effective_from: "next_billing_period" })`. */
const CANCELING = subscriptionOn(TEAM, "11000", {
  status: "active",
  canceled_at: null,
  next_billed_at: null,
  scheduled_change: { action: "cancel", effective_at: PERIOD_END, resume_at: null, items: null },
});

/** D) the same subscription after `update({ scheduled_change: null })` — the withdrawal. */
const WITHDRAWN = subscriptionOn(TEAM, "11000");

/** The thrown `PithyError`, or undefined. Keeps each refusal a single readable line. */
async function thrown(run: () => Promise<unknown>): Promise<PithyError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PithyError;
  }
}

describe("readPaddleStanding", () => {
  test("reports the cancellation the status hides", async () => {
    // The recorded post-cancel subscription says `active`, `canceled_at: null` and `next_billed_at: null`.
    // Two of the three claim the subscription is fine and the third says nothing at all — so a rail that
    // read the status would tell a customer who canceled that they will be billed again.
    const transport = paddle({ subscription: CANCELING });
    const standing = await readPaddleStanding(purchase(), options(transport));

    expect(standing).toEqual({
      status: "active",
      currency: "usd",
      currentPeriodEndsAt: new Date(PERIOD_END),
      nextBilledAt: null,
      scheduledChange: { action: "cancel", effectiveAt: new Date(PERIOD_END), resumesAt: null },
    });
  });

  test("a subscription with nothing scheduled renews, and says so", async () => {
    // Anti-vacuity for the case above: the mapping is plainly able to report a null scheduled change, so
    // the `cancel` there is read from the payload rather than produced by a reader that always says it.
    const transport = paddle({ subscription: WITHDRAWN });
    const standing = await readPaddleStanding(purchase(), options(transport));
    expect(standing?.scheduledChange).toBeNull();
    expect(standing?.nextBilledAt).toEqual(new Date(PERIOD_END));
  });

  test("a purchase that names no subscription is undefined, and asks Paddle nothing", async () => {
    const transport = paddle({});
    expect(
      await readPaddleStanding(purchase({ providerTransactionId: "txn_01kzvyz" }), options(transport)),
    ).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
  });

  test("a subscription Paddle no longer knows is undefined rather than a refusal", async () => {
    const transport = paddle({ refusal: { on: "subscription", status: 404 } });
    expect(await readPaddleStanding(purchase(), options(transport))).toBeUndefined();
  });
});

describe("previewPaddleChange", () => {
  test("an upgrade quotes what settles today, and nothing later", async () => {
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: UPGRADE_PREVIEW });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(quote).toEqual({
      settlesToday: { outcome: "charge", amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" } },
      nextInvoice: null,
      recurring: {
        amount: { amountMinor: 11976, currency: "usd", rendered: "$119.76" },
        startsAt: new Date(PERIOD_END),
      },
    });
  });

  test("the upgrade is previewed with the verb and the mode Paddle documents", async () => {
    // Nothing in this rail had ever issued a PATCH before #465 — every call was a GET or a POST — and
    // `paddleJson` defaults a request carrying a body to POST. A preview sent as a POST is a 404 from
    // Paddle reported to an operator as "this rail is not configured", so the verb is asserted, not assumed.
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: UPGRADE_PREVIEW });
    await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    const sent = transport.calls.find((call) => call.url.endsWith("/preview"));
    expect(sent?.method).toBe("PATCH");
    expect(sent?.url).toBe(`https://sandbox-api.paddle.com/subscriptions/${SUB}/preview`);
    expect(sent?.body).toEqual({
      items: [{ price_id: TEAM, quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
      on_payment_failure: "prevent_change",
    });
  });

  test("a downgrade quotes nothing today, the credit on the next invoice, and the new rate", async () => {
    // The recording that cost the quote a third part. `immediate_transaction` is null *and* `result` is a
    // credit of 6558 at the same time: read `result` as today's headline and the screen promises money
    // the customer will look for and not find; read the missing transaction as the whole answer and 65.58
    // dollars vanish from the quote.
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      preview: DOWNGRADE_PREVIEW,
    });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: SOLO }, options(transport));

    expect(quote).toEqual({
      settlesToday: { outcome: "nothing" },
      nextInvoice: {
        settlement: { outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } },
        at: new Date(PERIOD_END),
      },
      recurring: { amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" }, startsAt: new Date(PERIOD_END) },
    });
  });

  test("a downgrade is previewed in the deferred mode, never the immediate one", async () => {
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      preview: DOWNGRADE_PREVIEW,
    });
    await previewPaddleChange({ purchase: purchase(), providerProductId: SOLO }, options(transport));

    const sent = transport.calls.find((call) => call.url.endsWith("/preview"));
    expect(sent?.body?.proration_billing_mode).toBe("prorated_next_billing_period");
  });

  test("the credit lands as `credit`, never as a charge of the same size", async () => {
    // 6558 and 6558 are the same characters and the opposite meaning. The direction is the discriminant,
    // so this is the assertion that a screen cannot render one as the other.
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      preview: DOWNGRADE_PREVIEW,
    });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: SOLO }, options(transport));
    expect(quote.nextInvoice?.settlement.outcome).toBe("credit");
  });

  test("the figure is rendered in the locale the route resolved, not in the kit's", async () => {
    // #465: Paddle's `subscriptions.preview` returns no formatted total at any depth, so a quote that
    // did not render one leaves every screen downstream unable to state what the customer is confirming.
    // The locale is the reader's, threaded from `c.var.t.formattingLocale` through `RailRequestContext`.
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: UPGRADE_PREVIEW });
    const quote = await previewPaddleChange(
      { purchase: purchase(), providerProductId: TEAM },
      options(transport),
      "es",
    );

    expect(quote.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: renderMoney(6582, "usd", "es") },
    });
    // Not merely "some string": a Spanish reader's money must not be spelled in English.
    expect(quote.settlesToday.outcome === "charge" && quote.settlesToday.amount.rendered).not.toBe("$65.82");
    expect(quote.recurring?.amount.rendered).toBe(renderMoney(11976, "usd", "es"));
    // The integer is untouched by any of it — the amount is Paddle's and only its spelling is ours.
    expect(quote.recurring?.amount.amountMinor).toBe(11976);
  });

  test("no locale still states the figure, in the kit's own language", async () => {
    // The stated fallback. A reader whose locale did not resolve loses their language, never the amount:
    // a confirmation screen with a blank where the price goes is the one outcome worse than English.
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: UPGRADE_PREVIEW });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));
    expect(quote.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: renderMoney(6582, "usd", RENDER_FALLBACK_LOCALE) },
    });
  });

  test("a currency nothing can put a symbol on refuses the quote rather than throwing out of `Intl`", async () => {
    // `currencyOf` lowercases whatever Paddle sent and only refuses an empty string, so a store answering
    // with something that is not a code reaches the renderer with an amount that parses. `Intl` throws a
    // `RangeError` on it, which would reach a customer's confirmation screen as a 500. It is refused as
    // the unreadable response it is — the same answer every other malformed figure in this file gets.
    const named = {
      ...UPGRADE_PREVIEW,
      update_summary: {
        ...UPGRADE_PREVIEW.update_summary,
        result: { action: "charge", amount: "6582", currency_code: "DOLLARS" },
      },
    };
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: named });
    await expect(
      previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport)),
    ).rejects.toThrow(PaymentsProviderUnavailableError);
  });

  test("Paddle's uppercase currency is lowered before it reaches the quote", async () => {
    // `QuotedMoney` refuses `"USD"` on purpose: a quote carrying it compares unequal to the purchase rows
    // for the same money and sorts into a second bucket in every report that groups by currency. So the
    // rail translates — and the fixture is asserted to have said `"USD"`, or this proves nothing.
    expect(JSON.stringify(UPGRADE_PREVIEW)).toContain('"USD"');
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: UPGRADE_PREVIEW });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(quote.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" },
    });
    expect(quote.recurring?.amount.currency).toBe("usd");
  });

  test("a preview of the plan already held still asks Paddle — a read has no no-op", async () => {
    // The no-op exists to stop a retried *write* prorating twice. Borrowing it here would mean inventing a
    // recurring figure to fill the quote with, which is the one thing this package will not do.
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      preview: DOWNGRADE_PREVIEW,
    });
    await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));
    expect(transport.calls.some((call) => call.url.endsWith("/preview"))).toBe(true);
  });

  test("the existing quantity is carried through unchanged", async () => {
    // Paddle's update *replaces* the items array. A five-seat subscription rewritten as quantity 1 is four
    // seats silently canceled, and no read afterwards distinguishes that from an intended change.
    const five = subscriptionOn(SOLO, "600", { items: [line(SOLO, "600", { quantity: 5 })] });
    const transport = paddle({ subscription: five, prices: PRICES, preview: UPGRADE_PREVIEW });
    await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    const sent = transport.calls.find((call) => call.url.endsWith("/preview"));
    expect(sent?.body?.items).toEqual([{ price_id: TEAM, quantity: 5 }]);
  });

  test("a subscription carrying two items is refused rather than rewritten to one", async () => {
    // The refusal is the cheap failure. Sending one item to a two-item subscription deletes the other, and
    // that is a write to somebody's billing no later read can tell from a change they asked for.
    const two = subscriptionOn(TEAM, "11000", {
      items: [line(TEAM, "11000"), line("pri_01kzvyz9addonseatsnotareal", "500", { quantity: 2 })],
    });
    const transport = paddle({ subscription: two, prices: PRICES });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: SOLO }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.status).toBe(409);
    expect(error?.payload.detail).toContain("2 items");
    expect(writes(transport)).toHaveLength(0);
  });

  test("a quantity the rail would have to guess is refused rather than guessed", async () => {
    const vague = subscriptionOn(SOLO, "600", { items: [line(SOLO, "600", { quantity: null })] });
    const transport = paddle({ subscription: vague, prices: PRICES });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain("quantity");
    expect(writes(transport)).toHaveLength(0);
  });

  test("two prices in different currencies is a direction nobody can read, so it refuses", async () => {
    // 600 EUR against 11000 USD is not a comparison. Guessing the mode from it charges a downgrading
    // customer immediately, or defers an upgrade the store expected to collect.
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: { [SOLO]: price(SOLO, "600", "EUR") },
    });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: SOLO }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain("currenc");
    expect(writes(transport)).toHaveLength(0);
  });

  test("a subscription that is ending quotes no recurring amount rather than failing", async () => {
    // Reachable, and not hypothetically: a preview may be asked for on a subscription with a cancellation
    // already scheduled — `changePlan` refuses that, a read does not — and Paddle blanks `next_billed_at`
    // on exactly those. `recurring: null` is the schema's word for "nothing renews after this change",
    // which is a sentence a screen writes. Throwing here would take the figures away from the screen whose
    // job is to explain why the move cannot be made yet.
    const ending = { ...UPGRADE_PREVIEW, next_billed_at: null, scheduled_change: CANCELING.scheduled_change };
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: ending });
    const quote = await previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(quote.recurring).toBeNull();
    // And the part that does settle is still stated. A quote with nothing in it is not the honest answer.
    expect(quote.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" },
    });
  });

  test("a renewal date with no recurring block is the provider declining, and refuses", async () => {
    // The other null, and the reason the two are separated. Paddle named a date and then said nothing about
    // what falls due on it; the figure a rail would have to invent there is zero, and "then $0.00/month" is
    // a promise nobody can keep.
    const mute = { ...UPGRADE_PREVIEW, recurring_transaction_details: null };
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: mute });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/provider_unavailable");
  });

  test("a preview with no update summary is a shape change, not a quote of nothing", async () => {
    // A quote that could be absent is a confirm button rendered beside nothing. `provider_unavailable` is
    // what tells a screen to say so — where `settlesToday: nothing` would say the change is free.
    const mute = { ...UPGRADE_PREVIEW, update_summary: null };
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: mute });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/provider_unavailable");
  });

  test("a settlement action this build cannot read refuses rather than rendering itself", async () => {
    const odd = {
      ...UPGRADE_PREVIEW,
      update_summary: {
        ...UPGRADE_PREVIEW.update_summary,
        result: { action: "adjust", amount: "6582", currency_code: "USD" },
      },
    };
    const transport = paddle({ subscription: subscriptionOn(SOLO, "600"), prices: PRICES, preview: odd });

    const error = await thrown(() =>
      previewPaddleChange({ purchase: purchase(), providerProductId: TEAM }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/provider_unavailable");
    expect(error?.payload.detail).toContain("adjust");
  });
});

describe("changePaddlePlan", () => {
  test("an upgrade is written with PATCH, the complete items array, and the immediate mode", async () => {
    const transport = paddle({
      subscription: subscriptionOn(SOLO, "600"),
      prices: PRICES,
      update: subscriptionOn(TEAM, "11000"),
    });
    await changePaddlePlan({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    const sent = writes(transport)[0];
    expect(sent?.method).toBe("PATCH");
    expect(sent?.url).toBe(`https://sandbox-api.paddle.com/subscriptions/${SUB}`);
    expect(sent?.url).not.toContain("/preview");
    expect(sent?.body).toEqual({
      items: [{ price_id: TEAM, quantity: 1 }],
      proration_billing_mode: "prorated_immediately",
      on_payment_failure: "prevent_change",
    });
  });

  test("a downgrade defers the credit to the next billing period", async () => {
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      update: subscriptionOn(SOLO, "600"),
    });
    await changePaddlePlan({ purchase: purchase(), providerProductId: SOLO }, options(transport));
    expect(writes(transport)[0]?.body?.proration_billing_mode).toBe("prorated_next_billing_period");
  });

  test("a move between two prices of the same size charges immediately", async () => {
    // The boundary the rule states: higher *or equal* prorates immediately. A same-price move settles
    // nothing either way, and deferring it would leave a customer's plan changed with a phantom line
    // waiting on their next invoice.
    const twin = "pri_01kzvyz9twinofteamnotareal";
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: { [twin]: price(twin, "11000") },
      update: subscriptionOn(twin, "11000"),
    });
    await changePaddlePlan({ purchase: purchase(), providerProductId: twin }, options(transport));
    expect(writes(transport)[0]?.body?.proration_billing_mode).toBe("prorated_immediately");
  });

  test("a change of billing frequency is immediate whatever the direction, because Paddle allows nothing else", async () => {
    // Paddle accepts only `prorated_immediately`, `full_immediately` and `do_not_bill` when the billing
    // cycle changes. A yearly plan moving to a cheaper monthly one is a downgrade by unit price, and the
    // deferred mode the direction rule would pick is a 400 — reported to an operator as "this rail is not
    // configured", which sends them to check a key that is fine. `do_not_bill` is a free change and
    // unreachable here, so the immediate mode is the only one left.
    const yearly = "pri_01kzvyz9yearlyteamnotareal";
    const annual = subscriptionOn(yearly, "110000", {
      items: [line(yearly, "110000", { cycle: { interval: "year", frequency: 1 } })],
    });
    const transport = paddle({ subscription: annual, prices: PRICES, update: subscriptionOn(TEAM, "11000") });
    await changePaddlePlan({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(writes(transport)[0]?.body?.proration_billing_mode).toBe("prorated_immediately");
  });

  test("the same move within one frequency still defers, so the rule above is a frequency rule", async () => {
    // Anti-vacuity. Without this the case above passes on a rail that had simply stopped deferring.
    const transport = paddle({
      subscription: subscriptionOn(TEAM, "11000"),
      prices: PRICES,
      update: subscriptionOn(SOLO, "600"),
    });
    await changePaddlePlan({ purchase: purchase(), providerProductId: SOLO }, options(transport));
    expect(writes(transport)[0]?.body?.proration_billing_mode).toBe("prorated_next_billing_period");
  });

  test("the plan already held is a success, and Paddle is not written to", async () => {
    // The retry answer. These verbs sit behind a network and callers retry; a second delivery of the same
    // instruction must not become a second proration, and 409 for the state the caller asked for is simply
    // wrong — the subscription is how they wanted it.
    const transport = paddle({ subscription: subscriptionOn(TEAM, "11000") });
    const standing = await changePaddlePlan({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(standing.status).toBe("active");
    expect(writes(transport)).toHaveLength(0);
    // And not by declining to look: the plan was read before it was found to be the plan asked for.
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.method).toBe("GET");
  });

  test("a plan move on a subscription already scheduled to change is refused", async () => {
    // Honoring one instruction means discarding the other, and Paddle's own refusal for it arrives as an
    // ordinary 4xx — which this rail maps to `rail_not_configured`, sending an operator to check a key
    // that is fine. Refused here instead, with the pending action named.
    const transport = paddle({ subscription: CANCELING, prices: PRICES });

    const error = await thrown(() =>
      changePaddlePlan({ purchase: purchase(), providerProductId: SOLO }, options(transport)),
    );
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain("cancel");
    expect(writes(transport)).toHaveLength(0);
  });

  test("the answer is a standing and nothing a projection could write", async () => {
    // The webhook owns the purchase row. A rail that answered a provider event here would be a second
    // producer of a row the projection already owns, and the two would race on `providerEventAt`.
    const transport = paddle({
      subscription: subscriptionOn(SOLO, "600"),
      prices: PRICES,
      update: subscriptionOn(TEAM, "11000"),
    });
    const standing = await changePaddlePlan({ purchase: purchase(), providerProductId: TEAM }, options(transport));

    expect(Object.keys(standing).sort()).toEqual([
      "currency",
      "currentPeriodEndsAt",
      "nextBilledAt",
      "scheduledChange",
      "status",
    ]);
    for (const projectable of ["rail", "providerTransactionId", "role", "payload", "providerEventAt", "amountMinor"]) {
      expect(Object.keys(standing)).not.toContain(projectable);
    }
  });
});

describe("cancelPaddleSubscription", () => {
  test("at_period_end is Paddle's next_billing_period, and the answer is the store's own", async () => {
    // The recorded response: `active`, `next_billed_at` null, a cancel scheduled for 15 Sep. No prediction
    // gets that right, which is why a write verb answers a standing rather than nothing.
    const transport = paddle({ subscription: subscriptionOn(TEAM, "11000"), cancel: CANCELING });
    const standing = await cancelPaddleSubscription(
      { purchase: purchase(), timing: "at_period_end" },
      options(transport),
    );

    const sent = writes(transport)[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe(`https://sandbox-api.paddle.com/subscriptions/${SUB}/cancel`);
    expect(sent?.body).toEqual({ effective_from: "next_billing_period" });
    expect(standing.status).toBe("active");
    expect(standing.nextBilledAt).toBeNull();
    expect(standing.scheduledChange).toEqual({ action: "cancel", effectiveAt: new Date(PERIOD_END), resumesAt: null });
  });

  test("now is Paddle's immediately", async () => {
    const canceled = subscriptionOn(TEAM, "11000", { status: "canceled", canceled_at: "2026-08-28T11:20:00Z" });
    const transport = paddle({ subscription: subscriptionOn(TEAM, "11000"), cancel: canceled });
    const standing = await cancelPaddleSubscription({ purchase: purchase(), timing: "now" }, options(transport));

    expect(writes(transport)[0]?.body).toEqual({ effective_from: "immediately" });
    expect(standing.status).toBe("canceled");
  });

  test("canceling what is already scheduled to cancel writes nothing", async () => {
    const transport = paddle({ subscription: CANCELING });
    const standing = await cancelPaddleSubscription(
      { purchase: purchase(), timing: "at_period_end" },
      options(transport),
    );

    expect(standing.scheduledChange?.action).toBe("cancel");
    expect(writes(transport)).toHaveLength(0);
  });

  test("ending it today is not the same request, so a scheduled cancel does not swallow it", async () => {
    // The no-op is "already in the state asked for", and a subscription that ends on the 15th is not a
    // subscription that ended today. Support asking for `now` against a scheduled cancel must reach Paddle.
    const canceled = subscriptionOn(TEAM, "11000", { status: "canceled", scheduled_change: null });
    const transport = paddle({ subscription: CANCELING, cancel: canceled });
    await cancelPaddleSubscription({ purchase: purchase(), timing: "now" }, options(transport));

    expect(writes(transport)).toHaveLength(1);
    expect(writes(transport)[0]?.body).toEqual({ effective_from: "immediately" });
  });

  test("a subscription the store already ended is not canceled a second time", async () => {
    const canceled = subscriptionOn(TEAM, "11000", { status: "canceled", scheduled_change: null });
    const transport = paddle({ subscription: canceled });
    const standing = await cancelPaddleSubscription({ purchase: purchase(), timing: "now" }, options(transport));

    expect(standing.status).toBe("canceled");
    expect(writes(transport)).toHaveLength(0);
  });
});

describe("keepPaddleSubscription", () => {
  test("withdraws a scheduled cancellation by clearing the whole field", async () => {
    const transport = paddle({ subscription: CANCELING, update: WITHDRAWN });
    const standing = await keepPaddleSubscription(purchase(), options(transport));

    const sent = writes(transport)[0];
    expect(sent?.method).toBe("PATCH");
    expect(sent?.url).toBe(`https://sandbox-api.paddle.com/subscriptions/${SUB}`);
    expect(sent?.body).toEqual({ scheduled_change: null });
    expect(standing.scheduledChange).toBeNull();
    expect(standing.nextBilledAt).toEqual(new Date(PERIOD_END));
  });

  test("refuses when what is pending is a pause, because clearing it would restart billing", async () => {
    // Paddle offers no verb for withdrawing a cancellation: the update clears `scheduled_change` wholesale,
    // and that field also holds a scheduled pause. A rail that simply sent the clear would un-pause a paused
    // customer's account — on a request that said nothing about pausing.
    const pausing = subscriptionOn(TEAM, "11000", {
      scheduled_change: { action: "pause", effective_at: PERIOD_END, resume_at: null, items: null },
    });
    const transport = paddle({ subscription: pausing });

    const error = await thrown(() => keepPaddleSubscription(purchase(), options(transport)));
    expect(error?.payload.code).toBe("payments/subscription_change_refused");
    expect(error?.payload.detail).toContain("pause");
    expect(writes(transport)).toHaveLength(0);
  });

  test("refuses a scheduled resume for the same reason", async () => {
    const resuming = subscriptionOn(TEAM, "11000", {
      scheduled_change: { action: "resume", effective_at: PERIOD_END, resume_at: PERIOD_END, items: null },
    });
    const transport = paddle({ subscription: resuming });

    const error = await thrown(() => keepPaddleSubscription(purchase(), options(transport)));
    expect(error?.payload.detail).toContain("resume");
    expect(writes(transport)).toHaveLength(0);
  });

  test("a subscription with nothing scheduled already renews, so it writes nothing", async () => {
    // The retry of a withdrawal that worked. It already renews, which is what the caller asked for.
    const transport = paddle({ subscription: WITHDRAWN });
    const standing = await keepPaddleSubscription(purchase(), options(transport));

    expect(standing.scheduledChange).toBeNull();
    expect(writes(transport)).toHaveLength(0);
  });
});
