// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PaymentsProductType } from "../config/config";
import { PurchaseEnvironment } from "../data/purchase";
import { PAYMENTS_RAILS } from "../data/rail";
import { PurchaseStatus } from "../data/status";
import {
  CHECKOUT_SESSION_PARAM,
  createCheckout,
  createPortal,
  getEntitlements,
  isEntitlementView,
  isPurchaseView,
  openBillingPortal,
  openStoreSubscriptions,
  PAYMENTS_BASE_PATH,
  type PaymentsClientEnvironment,
  type PaymentsClientProductType,
  type PaymentsClientRail,
  type PaymentsClientStatus,
  type PaymentsFetch,
  type PaymentsRequestInit,
  restorePurchases,
  returnedCheckoutSession,
  STORE_SUBSCRIPTION_URLS,
  startCheckout,
  submitPurchase,
} from "./api";

/** One recorded call, so a test can assert the method, the path, and the cookie behaviour together. */
interface Call {
  url: string;
  init: PaymentsRequestInit | undefined;
}

/** A fetch that answers with `body` at `status`, recording what it was asked. */
function stubFetch(status: number, body: unknown, calls: Call[] = []): PaymentsFetch & { calls: Call[] } {
  const fetcher = (url: string, init?: PaymentsRequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  };
  return Object.assign(fetcher, { calls });
}

/** A fetch that rejects, the way an offline browser does. */
const offline: PaymentsFetch = () => Promise.reject(new Error("network"));

/** A fetch whose body is not JSON at all — a proxy's HTML error page. */
const unreadable: PaymentsFetch = () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("not json")) });

const ENTITLEMENTS = { entitlements: [{ key: "pro", granted: true, expiresAt: null }] };

const PURCHASE = {
  id: "p-1",
  rail: "stripe",
  productId: "pro_monthly",
  type: "subscription",
  status: "active",
  environment: "production",
  purchasedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
  outcome: "created",
};

/** The wire shape `pithyErrorHandler` emits: `{ error: <public payload> }`, with `detail` stripped. */
const REFUSAL = {
  error: {
    code: "payments/product_not_found",
    status: 404,
    message: "That product isn't sold here.",
    action: "Check the product id against pithy.config.ts.",
  },
};

/**
 * The wire unions are declared literally in `api.ts` rather than imported from `../data/*`, because the
 * client module compiles inside an adopter's DOM-typed browser program where the server's type graph does
 * not belong. That trade is only safe with a drift guard, and this is it.
 */
describe("the client's literal unions match the schemas they mirror", () => {
  test("rails", () => {
    const rails: PaymentsClientRail[] = ["apple", "google", "stripe", "lemonSqueezy"];
    expect([...PAYMENTS_RAILS].sort()).toEqual([...rails].sort());
  });

  test("product types", () => {
    const types: PaymentsClientProductType[] = ["consumable", "non_consumable", "subscription"];
    expect([...PaymentsProductType.options].sort()).toEqual([...types].sort());
  });

  test("purchase statuses", () => {
    const statuses: PaymentsClientStatus[] = [
      "active",
      "canceled",
      "expired",
      "in_grace",
      "never_paid",
      "on_hold",
      "paused",
      "refunded",
      "revoked",
    ];
    expect([...PurchaseStatus.options].sort()).toEqual([...statuses].sort());
  });

  test("store environments", () => {
    const environments: PaymentsClientEnvironment[] = ["production", "sandbox"];
    expect([...PurchaseEnvironment.options].sort()).toEqual([...environments].sort());
  });
});

describe("the guards", () => {
  test("accept the shapes the routes actually return", () => {
    expect(isEntitlementView({ key: "pro", granted: true, expiresAt: null })).toBe(true);
    expect(isPurchaseView(PURCHASE)).toBe(true);
  });

  test("refuse a missing field, a wrong type, and a value that is not an object at all", () => {
    expect(isEntitlementView({ key: "pro", granted: true })).toBe(false);
    expect(isEntitlementView({ key: "pro", granted: "yes", expiresAt: null })).toBe(false);
    expect(isEntitlementView(null)).toBe(false);
    expect(isEntitlementView("pro")).toBe(false);
    expect(isPurchaseView({ ...PURCHASE, rail: "amazon" })).toBe(false);
    expect(isPurchaseView({ ...PURCHASE, status: "cancelled" })).toBe(false);
  });
});

describe("getEntitlements", () => {
  test("reads the caller's own entitlements same-origin, with the session cookie", async () => {
    const fetcher = stubFetch(200, ENTITLEMENTS);
    const result = await getEntitlements({ fetch: fetcher });
    expect(result).toEqual({ ok: true, value: [{ key: "pro", granted: true, expiresAt: null }] });

    const [call] = fetcher.calls;
    expect(call?.url).toBe("/payments/entitlements");
    expect(call?.init?.credentials).toBe("include");
    // No bearer token anywhere near the browser path — the cookie is the credential.
    expect(JSON.stringify(call?.init?.headers ?? {})).not.toMatch(/authorization/i);
  });

  test("honours a project that mounted the routes somewhere else", async () => {
    const fetcher = stubFetch(200, ENTITLEMENTS);
    await getEntitlements({ fetch: fetcher, basePath: "/billing" });
    expect(fetcher.calls[0]?.url).toBe("/billing/entitlements");
  });

  test("a customer who genuinely holds nothing reads as a successful empty list", async () => {
    // The case every failure below must be distinguishable from. `[]` here is an answer.
    await expect(getEntitlements({ fetch: stubFetch(200, { entitlements: [] }) })).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  test("a failed read is never an empty list — the four failures each keep their own code", async () => {
    // The whole of #302. `[]` is a positive claim that the customer is on the free floor, and a screen
    // that names the plan renders it as such. None of these four may be mistaken for it.
    const unreachable = await getEntitlements({ fetch: offline });
    expect(unreachable).toEqual({
      ok: false,
      failure: { code: "client/unreachable", message: expect.any(String), action: expect.any(String) },
    });

    const nonJson = await getEntitlements({ fetch: unreadable });
    expect(nonJson.ok).toBe(false);
    if (!nonJson.ok) expect(nonJson.failure.code).toBe("client/unreadable");

    // A 500 carrying the Worker's own error envelope keeps the server's code, so an operator sees it.
    const server = await getEntitlements({ fetch: stubFetch(500, REFUSAL) });
    expect(server.ok).toBe(false);
    if (!server.ok) expect(server.failure.code).toBe(REFUSAL.error.code);

    // A body that fails the type guard is unreadable, not empty.
    const body = { entitlements: [{ key: "pro", granted: true, expiresAt: null }, { key: "team" }] };
    const malformed = await getEntitlements({ fetch: stubFetch(200, body) });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.failure.code).toBe("client/unreadable");
  });

  test("with no fetch anywhere it answers a failure rather than throwing", async () => {
    // Server-side rendering, or a test harness with no global. Still not a throw.
    const result = await getEntitlements({ fetch: undefined, global: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("client/unreachable");
  });

  test("fail-shut is one line the caller writes, and it reads as the decision it is", async () => {
    // The behaviour the old signature hard-coded, kept by whoever wants it — `holdsEntitlement` does
    // exactly this. The point is that it is now visible at the call site instead of buried in the reader.
    const result = await getEntitlements({ fetch: offline });
    expect(result.ok ? result.value : []).toEqual([]);
  });
});

describe("no reader in this module discards a PaymentsResult", () => {
  // #302 landed because one reader threw away a failure `call` had already built. A fifth producer must
  // fail the build rather than repeat it. `PaymentsResult` is a type and erased at runtime, so the only
  // honest check is over the source text — the same shape as capabilityVersions.test.ts.
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

  /**
   * The same source with comments removed. The negative sweep below is about what the module *does*, and
   * this module documents the shape it refuses by quoting it — so a sweep over raw text would flag the
   * docblock that explains the rule as a violation of it.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /** Every exported function in api.ts, as `[name, returnAnnotation, body]`. */
  const exported = [...code.matchAll(/export (?:async )?function (\w+)\(([\s\S]*?)\): ([^{]+)\{([\s\S]*?)\n\}/g)].map(
    (match) => ({ name: match[1] ?? "", returns: (match[3] ?? "").trim(), body: match[4] ?? "" }),
  );

  test("the sweep sees the module it is guarding", () => {
    // Anti-vacuous: a regex that silently matched nothing would pass every assertion below.
    expect(exported.length).toBeGreaterThan(6);
    expect(exported.map((fn) => fn.name)).toContain("getEntitlements");
  });

  test("every reader that goes through `call` answers a PaymentsResult", () => {
    // A "reader" is a function whose body reaches the one fetch path. The three navigators
    // (startCheckout, openBillingPortal) deliberately answer `PaymentsFailure | null` — they are actions
    // that leave the page, not readers, and they reach `call` only through `leaveFor`.
    const navigators = new Set(["startCheckout", "openBillingPortal"]);
    const readers = exported.filter((fn) => /\bcall[(<]/.test(fn.body) && !navigators.has(fn.name));

    expect(readers.length).toBeGreaterThan(3);
    for (const reader of readers) {
      expect(`${reader.name}: ${reader.returns}`).toMatch(/PaymentsResult</);
    }
  });

  test("no reader collapses a refusal into an empty value", () => {
    // The exact line #302 removed: `return result.ok ? result.value.entitlements : [];`
    expect(code).not.toMatch(/result\.ok\s*\?[^:]*:\s*(\[\]|null|undefined|false)/);
  });
});

describe("submitPurchase", () => {
  test("posts the receipt and hands back the projected purchase", async () => {
    const fetcher = stubFetch(200, { purchase: PURCHASE, entitlements: ENTITLEMENTS.entitlements });
    const result = await submitPurchase({ rail: "stripe", receipt: "cs_test_1" }, { fetch: fetcher });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.purchase.id).toBe("p-1");
    const [call] = fetcher.calls;
    expect(call?.url).toBe("/payments/purchases");
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.body).toBe(JSON.stringify({ rail: "stripe", receipt: "cs_test_1" }));
  });

  test("maps a refusal to its code and its public message, never to a throw", async () => {
    const result = await submitPurchase({ rail: "apple", receipt: "x" }, { fetch: stubFetch(404, REFUSAL) });
    expect(result).toEqual({
      ok: false,
      failure: {
        code: "payments/product_not_found",
        message: "That product isn't sold here.",
        action: "Check the product id against pithy.config.ts.",
      },
    });
  });

  test("an error body the server did not shape becomes the generic failure, not undefined text", async () => {
    const result = await submitPurchase({ rail: "apple", receipt: "x" }, { fetch: stubFetch(502, "<html>") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("client/unreadable");
      expect(result.failure.message.length).toBeGreaterThan(0);
    }
  });

  test("an unreachable worker is a failure a screen can render", async () => {
    const result = await submitPurchase({ rail: "apple", receipt: "x" }, { fetch: offline });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("client/unreachable");
  });
});

describe("restorePurchases", () => {
  test("posts the whole batch on one rail", async () => {
    const fetcher = stubFetch(200, { purchases: [PURCHASE], entitlements: ENTITLEMENTS.entitlements });
    const result = await restorePurchases({ rail: "apple", receipts: ["a", "b"] }, { fetch: fetcher });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.purchases).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe("/payments/restore");
    expect(fetcher.calls[0]?.init?.body).toBe(JSON.stringify({ rail: "apple", receipts: ["a", "b"] }));
  });
});

const PADDLE_HANDOFF = {
  kind: "paddle",
  transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
  clientToken: "test_1234567890abcdef",
  environment: "sandbox",
  displayMode: "overlay",
} as const;

describe("createCheckout and createPortal", () => {
  test("return the handoff the server minted", async () => {
    const checkout = stubFetch(200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const created = await createCheckout({ productId: "pro_monthly" }, { fetch: checkout });
    expect(created).toEqual({
      ok: true,
      value: { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" },
    });
    expect(checkout.calls[0]?.url).toBe("/payments/checkout");
    expect(checkout.calls[0]?.init?.body).toBe(JSON.stringify({ productId: "pro_monthly" }));

    const portal = stubFetch(200, { url: "https://billing.stripe.com/p/session/1" });
    expect(await createPortal({ fetch: portal })).toEqual({
      ok: true,
      value: { url: "https://billing.stripe.com/p/session/1" },
    });
    // No body at all: there is exactly one billing account this caller may manage, and the server picks it.
    expect(portal.calls[0]?.init?.body).toBeUndefined();
  });

  test("return a paddle handoff whole, because there is nothing to navigate to", async () => {
    const fetcher = stubFetch(200, PADDLE_HANDOFF);
    const created = await createCheckout({ productId: "pro_monthly" }, { fetch: fetcher });
    expect(created).toEqual({ ok: true, value: PADDLE_HANDOFF });
  });

  test("refuse a redirect URL whose scheme is not http(s) — the client navigates to this value", async () => {
    // `location.assign("javascript:…")` executes in this page. The same guard the sign-in screen makes
    // on a social redirect, made here because this is where the value is read.
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "/relative", "", 7]) {
      const body = { kind: "redirect", url };
      const result = await createCheckout({ productId: "pro_monthly" }, { fetch: stubFetch(200, body) });
      expect(result.ok, String(url)).toBe(false);
    }
  });

  test("refuse a paddle handoff whose environment or display mode is not one this build knows", async () => {
    // Not pedantry: `environment` chooses which Paddle account `Paddle.Environment.set` points the
    // browser at, and a value this client cannot read means a server it does not understand. Opening a
    // checkout on a guess is opening one against the wrong account.
    const broken: Record<string, unknown>[] = [
      { ...PADDLE_HANDOFF, environment: "staging" },
      { ...PADDLE_HANDOFF, displayMode: "hosted" },
      { ...PADDLE_HANDOFF, transactionId: "" },
      { ...PADDLE_HANDOFF, clientToken: 7 },
    ];
    for (const body of broken) {
      const result = await createCheckout({ productId: "pro_monthly" }, { fetch: stubFetch(200, body) });
      expect(result.ok, JSON.stringify(body)).toBe(false);
    }
    // Anti-vacuity: the untouched handoff passes, so the four above fail on the field each one changed.
    const intact = await createCheckout({ productId: "pro_monthly" }, { fetch: stubFetch(200, { ...PADDLE_HANDOFF }) });
    expect(intact.ok).toBe(true);
  });

  test("refuse a portal deep link whose scheme is not http(s)", async () => {
    const body = {
      url: "https://sandbox-customer-portal.paddle.com/cpl_01",
      subscriptions: [
        { subscriptionId: "sub_01", cancel: "javascript:alert(1)", updatePaymentMethod: "https://portal/pay" },
      ],
    };
    expect((await createPortal({ fetch: stubFetch(200, body) })).ok).toBe(false);

    const fine = {
      ...body,
      subscriptions: [
        { subscriptionId: "sub_01", cancel: "https://portal/cancel", updatePaymentMethod: "https://portal/pay" },
      ],
    };
    expect((await createPortal({ fetch: stubFetch(200, fine) })).ok).toBe(true);
  });
});

describe("startCheckout and openBillingPortal", () => {
  test("navigate to the hosted page, and report nothing because there is nothing left to render", async () => {
    const visited: string[] = [];
    const outcome = await startCheckout(
      { productId: "pro_monthly" },
      {
        fetch: stubFetch(200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
        navigate: (url) => visited.push(url),
      },
    );
    expect(outcome).toEqual({ kind: "left" });
    expect(visited).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1"]);
  });

  test("hand a paddle handoff back rather than navigating, because there is nowhere to go", async () => {
    const visited: string[] = [];
    const outcome = await startCheckout(
      { productId: "pro_monthly" },
      { fetch: stubFetch(200, PADDLE_HANDOFF), navigate: (url) => visited.push(url) },
    );
    expect(outcome).toEqual({ kind: "paddle", handoff: PADDLE_HANDOFF });
    // The failure this shape exists to stop: a screen told "left" for a rail that never leaves, and a
    // buyer looking at a paywall whose button did nothing.
    expect(visited).toEqual([]);
  });

  test("never navigate when the session could not be created", async () => {
    const visited: string[] = [];
    const outcome = await startCheckout(
      { productId: "nope" },
      { fetch: stubFetch(404, REFUSAL), navigate: (url) => visited.push(url) },
    );
    expect(outcome.kind === "refused" && outcome.failure.code).toBe("payments/product_not_found");
    expect(visited).toEqual([]);
  });

  test("the portal behaves the same way", async () => {
    const visited: string[] = [];
    const ok = await openBillingPortal({
      fetch: stubFetch(200, { url: "https://billing.stripe.com/p/session/1" }),
      navigate: (url) => visited.push(url),
    });
    expect(ok).toBeNull();
    expect(visited).toEqual(["https://billing.stripe.com/p/session/1"]);

    const denied = await openBillingPortal({ fetch: stubFetch(404, REFUSAL), navigate: (url) => visited.push(url) });
    expect(denied?.code).toBe("payments/product_not_found");
    expect(visited).toHaveLength(1);
  });

  test("with no navigator available it reports rather than throwing", async () => {
    const outcome = await startCheckout(
      { productId: "pro_monthly" },
      { fetch: stubFetch(200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/1" }), global: {} },
    );
    expect(outcome.kind === "refused" && outcome.failure.code).toBe("client/no_browser");
  });
});

describe("openStoreSubscriptions", () => {
  test("sends the browser to the store's own management page", () => {
    const visited: string[] = [];
    expect(openStoreSubscriptions("apple", { navigate: (url) => visited.push(url) })).toBe(true);
    expect(openStoreSubscriptions("google", { navigate: (url) => visited.push(url) })).toBe(true);
    expect(visited).toEqual([STORE_SUBSCRIPTION_URLS.apple, STORE_SUBSCRIPTION_URLS.google]);
  });

  test("both URLs are the stores' own https pages, and Stripe has no entry", () => {
    // Stripe's equivalent is a session the server mints per caller; a static URL there is a link to nobody.
    expect(Object.keys(STORE_SUBSCRIPTION_URLS).sort()).toEqual(["apple", "google"]);
    for (const url of Object.values(STORE_SUBSCRIPTION_URLS)) expect(url.startsWith("https://")).toBe(true);
  });

  test("off a browser it reports rather than throwing", () => {
    expect(openStoreSubscriptions("apple", { global: {} })).toBe(false);
  });
});

describe("returnedCheckoutSession", () => {
  test("reads the session id Stripe substituted into the adopter's own success URL", () => {
    expect(CHECKOUT_SESSION_PARAM).toBe("session");
    expect(returnedCheckoutSession({ search: "?session=cs_test_1&utm=x" })).toBe("cs_test_1");
  });

  test("honours a project that named the query parameter something else", () => {
    expect(returnedCheckoutSession({ search: "?checkout=cs_test_1", param: "checkout" })).toBe("cs_test_1");
  });

  test("is null when the browser came back from anywhere else", () => {
    expect(returnedCheckoutSession({ search: "" })).toBeNull();
    expect(returnedCheckoutSession({ search: "?session=" })).toBeNull();
    expect(returnedCheckoutSession({ search: "?other=1" })).toBeNull();
  });

  test("off a browser it is null, not a crash", () => {
    expect(returnedCheckoutSession({ global: {} })).toBeNull();
  });
});

describe("the module's own shape", () => {
  test("mounts at the same default the config does", () => {
    expect(PAYMENTS_BASE_PATH).toBe("/payments");
  });
});
