// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type PaymentsFetch, type PaymentsRequestInit, STORE_SUBSCRIPTION_URLS } from "./api";
import { useCheckout, useEntitlement, usePurchase, useSubscription } from "./hooks";

/**
 * The hooks are rendered for real — mounted into a document, effects run, state observed — rather than
 * asserted through a pure helper. Loading order, the unmount guard, and "a refusal leaves the previous
 * value alone" are the whole substance of a hook, and none of them exists outside a render.
 *
 * `happy-dom` is a per-file environment, declared in the docblock above rather than as a third Vitest
 * project. That keeps these inside the `node` project, which is what `test:node` runs and what CI's
 * silent-skip check counts — a fourth project would be a suite nothing in CI executes.
 */

declare global {
  // React only permits `act` when the host says it is a test. Vitest does not set it; we do.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** One recorded request. */
interface Call {
  url: string;
  init: PaymentsRequestInit | undefined;
}

/** A fetch answering a queue of `[status, body]` pairs in order, recording every call. */
function queue(answers: [number, unknown][]): PaymentsFetch & { calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetcher = (url: string, init?: PaymentsRequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers[Math.min(index++, answers.length - 1)] ?? [500, {}];
    return Promise.resolve({
      ok: (status ?? 500) >= 200 && (status ?? 500) < 300,
      status: status ?? 500,
      json: () => Promise.resolve(body),
    });
  };
  return Object.assign(fetcher, { calls });
}

const PRO = { entitlements: [{ key: "pro", granted: true, expiresAt: null }] };
const NOTHING = { entitlements: [] };
const REFUSAL = { error: { code: "payments/product_not_found", status: 404, message: "Not sold here." } };
const PURCHASE = {
  id: "p-1",
  rail: "stripe",
  productId: "pro_monthly",
  type: "subscription",
  status: "active",
  environment: "production",
  purchasedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  outcome: "created",
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Mount a hook and return a live handle on its latest return value, plus every value it has returned.
 *
 * `history` is not a convenience. `act` flushes effects *and* the microtasks they queue, so by the time
 * this resolves the first read has already landed — the only way to observe the initial state a paywall
 * renders on its first frame is to have recorded it.
 */
async function render<T>(hook: () => T): Promise<{ current: T; history: T[] }> {
  const handle: { current: T; history: T[] } = { current: undefined as T, history: [] };
  function Probe(): null {
    handle.current = hook();
    handle.history.push(handle.current);
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  return handle;
}

/** Let every queued promise and the state update it causes settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useEntitlement", () => {
  test("starts not entitled and loading — a paywall fails closed while the read is in flight", async () => {
    // Never the other way round. A hook that started `entitled: true` would flash the paid screen to
    // everyone for one frame, which is both a leak and a worse experience than a spinner.
    const held = await render(() => useEntitlement("pro", { fetch: queue([[200, PRO]]) }));
    expect(held.history[0]).toMatchObject({ entitled: false, loading: true });
  });

  test("flips to entitled once the read lands", async () => {
    const held = await render(() => useEntitlement("pro", { fetch: queue([[200, PRO]]) }));
    await settle();
    expect(held.current).toMatchObject({ entitled: true, loading: false });
  });

  test("a key the caller does not hold stays false", async () => {
    const held = await render(() => useEntitlement("team", { fetch: queue([[200, PRO]]) }));
    await settle();
    expect(held.current).toMatchObject({ entitled: false, loading: false });
  });

  test("an entitlement present but not granted does not entitle", async () => {
    // The row exists with `granted: false` when a subscription lapsed. It is still a no.
    const lapsed = { entitlements: [{ key: "pro", granted: false, expiresAt: "2020-01-01T00:00:00.000Z" }] };
    const held = await render(() => useEntitlement("pro", { fetch: queue([[200, lapsed]]) }));
    await settle();
    expect(held.current.entitled).toBe(false);
  });

  test("an unreachable worker reads as not entitled, and stops loading", async () => {
    const dead: PaymentsFetch = () => Promise.reject(new Error("offline"));
    const held = await render(() => useEntitlement("pro", { fetch: dead }));
    await settle();
    expect(held.current).toMatchObject({ entitled: false, loading: false });
  });

  test("refresh re-reads, which is how a screen updates after a purchase completes", async () => {
    const fetcher = queue([
      [200, NOTHING],
      [200, PRO],
    ]);
    const held = await render(() => useEntitlement("pro", { fetch: fetcher }));
    await settle();
    expect(held.current.entitled).toBe(false);

    await act(async () => held.current.refresh());
    await settle();
    expect(held.current.entitled).toBe(true);
    expect(fetcher.calls).toHaveLength(2);
  });

  test("reads once per mount, not once per render", async () => {
    const fetcher = queue([[200, PRO]]);
    await render(() => useEntitlement("pro", { fetch: fetcher, basePath: "/payments" }));
    await settle();
    await settle();
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe("/payments/entitlements");
  });

  test("an answer arriving after unmount resolves quietly", async () => {
    // Narrower than it used to claim, on purpose.
    //
    // This test asserted nothing at all until a review caught it: it ran the scenario and ended, so it passed
    // with the liveness guard deleted. The obvious repair — count renders — does not work either, because
    // React 19 silently no-ops a state update on an unmounted root, so the guard has no observable effect
    // from outside the hook. What IS observable is that the late answer neither throws nor logs, which is what
    // this now pins; the guard itself is belt-and-braces against a future React that warns again, and against
    // a rewrite that does real work on the resolved value before touching state.
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);

    try {
      let land: (() => void) | undefined;
      const slow: PaymentsFetch = () =>
        new Promise((resolve) => {
          land = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(PRO) });
        });
      await render(() => useEntitlement("pro", { fetch: slow }));
      act(() => root.unmount());

      await act(async () => {
        land?.();
        await Promise.resolve();
      });

      expect(errors).toEqual([]);
    } finally {
      console.error = realError;
      root = createRoot(container);
    }
  });
});

describe("useCheckout", () => {
  test("creates the session and hands the browser to the hosted page", async () => {
    const visited: string[] = [];
    const fetcher = queue([[200, { url: "https://checkout.stripe.com/c/pay/cs_1" }]]);
    const held = await render(() => useCheckout({ fetch: fetcher, navigate: (url) => visited.push(url) }));

    expect(held.current.starting).toBe(false);
    await act(async () => {
      await held.current.start("pro_monthly");
    });
    expect(visited).toEqual(["https://checkout.stripe.com/c/pay/cs_1"]);
    expect(held.current.failure).toBeNull();
    expect(fetcher.calls[0]?.init?.body).toBe(JSON.stringify({ productId: "pro_monthly" }));
  });

  test("a refusal is a rendered message, not a throw, and nothing is navigated to", async () => {
    const visited: string[] = [];
    const held = await render(() =>
      useCheckout({ fetch: queue([[404, REFUSAL]]), navigate: (url) => visited.push(url) }),
    );
    await act(async () => {
      await held.current.start("nope");
    });
    expect(visited).toEqual([]);
    expect(held.current.failure?.code).toBe("payments/product_not_found");
    expect(held.current.failure?.message).toBe("Not sold here.");
    expect(held.current.starting).toBe(false);
  });

  test("a second attempt clears the first failure before it runs", async () => {
    const visited: string[] = [];
    const fetcher = queue([
      [404, REFUSAL],
      [200, { url: "https://checkout.stripe.com/c/pay/cs_2" }],
    ]);
    const held = await render(() => useCheckout({ fetch: fetcher, navigate: (url) => visited.push(url) }));
    await act(async () => {
      await held.current.start("nope");
    });
    expect(held.current.failure).not.toBeNull();

    await act(async () => {
      await held.current.start("pro_monthly");
    });
    expect(held.current.failure).toBeNull();
    expect(visited).toEqual(["https://checkout.stripe.com/c/pay/cs_2"]);
  });
});

describe("usePurchase", () => {
  test("submits a receipt and reports the projected purchase with the entitlements it produced", async () => {
    const fetcher = queue([[200, { purchase: PURCHASE, entitlements: PRO.entitlements }]]);
    const held = await render(() => usePurchase({ fetch: fetcher }));

    await act(async () => {
      await held.current.submit("stripe", "cs_test_1");
    });
    expect(held.current.purchase?.id).toBe("p-1");
    expect(held.current.entitlements).toEqual(PRO.entitlements);
    expect(held.current.failure).toBeNull();
    expect(held.current.busy).toBe(false);
  });

  test("restores a batch on one rail", async () => {
    const fetcher = queue([[200, { purchases: [PURCHASE], entitlements: PRO.entitlements }]]);
    const held = await render(() => usePurchase({ fetch: fetcher }));

    await act(async () => {
      await held.current.restore("apple", ["a", "b"]);
    });
    expect(held.current.entitlements).toEqual(PRO.entitlements);
    expect(fetcher.calls[0]?.url).toBe("/payments/restore");
  });

  test("a refused submission leaves the previous entitlements alone", async () => {
    // Half-clearing state on a failure is how a paywall flickers back over a feature the user owns.
    const fetcher = queue([
      [200, { purchase: PURCHASE, entitlements: PRO.entitlements }],
      [409, { error: { code: "payments/receipt_already_owned", status: 409, message: "Not yours." } }],
    ]);
    const held = await render(() => usePurchase({ fetch: fetcher }));
    await act(async () => {
      await held.current.submit("stripe", "cs_test_1");
    });
    await act(async () => {
      await held.current.submit("stripe", "cs_test_2");
    });

    expect(held.current.failure?.code).toBe("payments/receipt_already_owned");
    expect(held.current.entitlements).toEqual(PRO.entitlements);
    expect(held.current.purchase?.id).toBe("p-1");
  });

  test("a refused restore reports the failure and leaves the previous entitlements alone", async () => {
    // The restore half of the case above, which had no test at all: `restore` is the whole batch or nothing
    // (a receipt belonging to somebody else fails the request), so a user restoring on a second device sees
    // this path — and with the failure unreported the screen showed no reason at all.
    const fetcher = queue([
      [200, { purchases: [PURCHASE], entitlements: PRO.entitlements }],
      [409, { error: { code: "payments/receipt_already_owned", status: 409, message: "Not yours." } }],
    ]);
    const held = await render(() => usePurchase({ fetch: fetcher }));
    await act(async () => {
      await held.current.restore("apple", ["a"]);
    });
    await act(async () => {
      await held.current.restore("apple", ["b", "c"]);
    });

    expect(held.current.failure?.code).toBe("payments/receipt_already_owned");
    expect(held.current.entitlements).toEqual(PRO.entitlements);
    expect(held.current.busy).toBe(false);
  });
});

describe("useSubscription", () => {
  test("reads the caller's entitlements and reports whether any is granted", async () => {
    const held = await render(() => useSubscription({ fetch: queue([[200, PRO]]) }));
    expect(held.history[0]).toMatchObject({ loading: true, subscribed: false });
    await settle();
    expect(held.current.loading).toBe(false);
    expect(held.current.entitlements).toEqual(PRO.entitlements);
    expect(held.current.subscribed).toBe(true);
  });

  test("nothing held is not subscribed", async () => {
    const held = await render(() => useSubscription({ fetch: queue([[200, NOTHING]]) }));
    await settle();
    expect(held.current.subscribed).toBe(false);
  });

  test("manage() opens the billing portal", async () => {
    const visited: string[] = [];
    const fetcher = queue([
      [200, PRO],
      [200, { url: "https://billing.stripe.com/p/session/1" }],
    ]);
    const held = await render(() => useSubscription({ fetch: fetcher, navigate: (url) => visited.push(url) }));
    await settle();

    await act(async () => {
      await held.current.manage();
    });
    expect(visited).toEqual(["https://billing.stripe.com/p/session/1"]);
    expect(fetcher.calls[1]?.url).toBe("/payments/portal");
    expect(held.current.failure).toBeNull();
  });

  test("manageStore sends the visitor to the store that sold the subscription", async () => {
    // A web page cannot cancel a StoreKit subscription. Linking to Apple's own page is the whole of what
    // it can honestly offer, and the URL lives in the package so a store moving it is a minor release.
    const visited: string[] = [];
    const held = await render(() =>
      useSubscription({ fetch: queue([[200, PRO]]), navigate: (url) => visited.push(url) }),
    );
    await settle();
    act(() => held.current.manageStore("apple"));
    expect(visited).toEqual([STORE_SUBSCRIPTION_URLS.apple]);
  });

  test("a caller with no billing account gets the server's message, not a blank redirect", async () => {
    const visited: string[] = [];
    const fetcher = queue([
      [200, NOTHING],
      [404, { error: { code: "core/not_found", status: 404, message: "No billing account yet." } }],
    ]);
    const held = await render(() => useSubscription({ fetch: fetcher, navigate: (url) => visited.push(url) }));
    await settle();
    await act(async () => {
      await held.current.manage();
    });
    expect(visited).toEqual([]);
    expect(held.current.failure?.message).toBe("No billing account yet.");
  });
});
