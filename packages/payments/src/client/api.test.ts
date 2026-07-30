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
    const rails: PaymentsClientRail[] = ["apple", "google", "stripe"];
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
    expect(await getEntitlements({ fetch: fetcher })).toEqual([{ key: "pro", granted: true, expiresAt: null }]);

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

  test("a 500 reads as not entitled, not as a throw", async () => {
    // The safe direction for a client affordance: a paywall that cannot reach the worker shows the
    // paywall. The server check is the boundary, so failing closed here costs nothing.
    await expect(getEntitlements({ fetch: stubFetch(500, {}) })).resolves.toEqual([]);
  });

  test("an unreachable worker, an unparseable body, and a 401 all read as not entitled", async () => {
    await expect(getEntitlements({ fetch: offline })).resolves.toEqual([]);
    await expect(getEntitlements({ fetch: unreadable })).resolves.toEqual([]);
    await expect(getEntitlements({ fetch: stubFetch(401, REFUSAL) })).resolves.toEqual([]);
  });

  test("one malformed entry drops the whole list rather than half of it", async () => {
    // A partially-read list is worse than none: a screen would render as if the missing key were unheld.
    const body = { entitlements: [{ key: "pro", granted: true, expiresAt: null }, { key: "team" }] };
    await expect(getEntitlements({ fetch: stubFetch(200, body) })).resolves.toEqual([]);
  });

  test("with no fetch anywhere it answers empty rather than throwing", async () => {
    // Server-side rendering, or a test harness with no global. Still not a throw.
    await expect(getEntitlements({ fetch: undefined, global: {} })).resolves.toEqual([]);
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

describe("createCheckout and createPortal", () => {
  test("return the hosted URL the server minted", async () => {
    const checkout = stubFetch(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const created = await createCheckout({ productId: "pro_monthly" }, { fetch: checkout });
    expect(created).toEqual({ ok: true, value: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(checkout.calls[0]?.url).toBe("/payments/checkout");
    expect(checkout.calls[0]?.init?.body).toBe(JSON.stringify({ productId: "pro_monthly" }));

    const portal = stubFetch(200, { url: "https://billing.stripe.com/p/session/1" });
    expect(await createPortal({ fetch: portal })).toEqual({
      ok: true,
      value: "https://billing.stripe.com/p/session/1",
    });
    // No body at all: there is exactly one billing account this caller may manage, and the server picks it.
    expect(portal.calls[0]?.init?.body).toBeUndefined();
  });

  test("refuse a URL whose scheme is not http(s) — the client navigates to this value", async () => {
    // `location.assign("javascript:…")` executes in this page. The same guard the sign-in screen makes
    // on a social redirect, made here because this is where the value is read.
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "/relative", "", 7]) {
      const result = await createCheckout({ productId: "pro_monthly" }, { fetch: stubFetch(200, { url }) });
      expect(result.ok, String(url)).toBe(false);
    }
  });
});

describe("startCheckout and openBillingPortal", () => {
  test("navigate to the hosted page, and report nothing because there is nothing left to render", async () => {
    const visited: string[] = [];
    const failure = await startCheckout(
      { productId: "pro_monthly" },
      {
        fetch: stubFetch(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }),
        navigate: (url) => visited.push(url),
      },
    );
    expect(failure).toBeNull();
    expect(visited).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1"]);
  });

  test("never navigate when the session could not be created", async () => {
    const visited: string[] = [];
    const failure = await startCheckout(
      { productId: "nope" },
      { fetch: stubFetch(404, REFUSAL), navigate: (url) => visited.push(url) },
    );
    expect(failure?.code).toBe("payments/product_not_found");
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
    const failure = await startCheckout(
      { productId: "pro_monthly" },
      { fetch: stubFetch(200, { url: "https://checkout.stripe.com/c/pay/1" }), global: {} },
    );
    expect(failure?.code).toBe("client/no_browser");
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
