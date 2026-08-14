// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type PaymentsFetch, type PaymentsRequestInit, STORE_SUBSCRIPTION_URLS } from "./api";
import { PADDLE_FRAME_HEIGHT, PADDLE_FRAME_STYLE, PADDLE_NO_CONTAINER } from "./checkout";
import { GB, US_NEW_YORK } from "./fixtures/pricePreview";
import {
  type UsePricePreview,
  useCheckout,
  useEntitlement,
  usePaddle,
  usePaddleCheckout,
  usePricePreview,
  usePurchase,
  useSubscription,
} from "./hooks";
import {
  PADDLE_UNAVAILABLE,
  type PaddleCheckoutOpen,
  type PaddleInitializer,
  type PaddleJs,
  type PaddlePriceQuery,
  type PaddleRegistry,
  type PaddleSetup,
} from "./paddle";

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
async function render<T>(
  hook: () => T,
  options?: { strict?: boolean },
): Promise<{ current: T; history: T[]; rerender: () => Promise<void> }> {
  const handle = {
    current: undefined as T,
    history: [] as T[],
    // Re-rendering the same component is how "an inline options object does not restart the effect"
    // becomes observable: the hook is called again with a freshly built argument, exactly as it is in a
    // screen that re-renders for any other reason.
    rerender: async () => {
      await act(async () => {
        root.render(tree());
      });
    },
  };
  function Probe(): null {
    handle.current = hook();
    handle.history.push(handle.current);
    return null;
  }
  // `strict` mounts the hook the way `pithy ui add` mounts a screen: `src/client.tsx` wraps the router in
  // `StrictMode`, so every effect in a scaffolded app runs, cleans up and runs again in development. That
  // is not a simulation of a double mount — it is the double mount the adopter actually gets.
  const tree = () => (options?.strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe));
  await act(async () => {
    root.render(tree());
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

  test("a failed read is reported as its own state, not as an unheld key", async () => {
    // A lock may fail shut — `entitled` stays false — but it must still say it could not ask. A screen
    // that renders "you don't have Pro" and one that renders "we couldn't check" are different screens.
    const dead: PaymentsFetch = () => Promise.reject(new Error("offline"));
    const held = await render(() => useEntitlement("pro", { fetch: dead }));
    await settle();
    expect(held.current.entitled).toBe(false);
    expect(held.current.readFailure?.code).toBe("client/unreachable");
  });

  test("a customer who holds nothing is not a failed read", async () => {
    const held = await render(() => useEntitlement("pro", { fetch: queue([[200, NOTHING]]) }));
    await settle();
    expect(held.current).toMatchObject({ entitled: false, loading: false, readFailure: null });
  });

  test("a read that recovers clears the failure it reported", async () => {
    const fetcher = queue([
      [500, {}],
      [200, PRO],
    ]);
    const held = await render(() => useEntitlement("pro", { fetch: fetcher }));
    await settle();
    expect(held.current.readFailure).not.toBeNull();
    act(() => held.current.refresh());
    await settle();
    expect(held.current).toMatchObject({ entitled: true, readFailure: null });
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
    const fetcher = queue([[200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_1" }]]);
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
      [200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_2" }],
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

  test("a failed read is its own state, and never an empty entitlement list", async () => {
    // #302's motivating bug: a rail that names the visitor's plan rendered `Free` with an `Upgrade`
    // button for an Enterprise customer, because a 500 and "holds nothing" were the same value.
    const held = await render(() => useSubscription({ fetch: queue([[500, {}]]) }));
    await settle();
    expect(held.current.loading).toBe(false);
    expect(held.current.entitlements).toEqual([]);
    expect(held.current.subscribed).toBe(false);
    expect(held.current.readFailure).not.toBeNull();
  });

  test("a read failure and an action refusal are separate fields", async () => {
    // `failure` is the last thing the subscriber *asked for* and was refused. `readFailure` is the state
    // of the entitlements read. Collapsing them would let a stale portal error mask a broken read.
    const fetcher = queue([
      [200, PRO],
      [404, { error: { code: "core/not_found", status: 404, message: "No billing account yet." } }],
    ]);
    const held = await render(() => useSubscription({ fetch: fetcher }));
    await settle();
    expect(held.current.readFailure).toBeNull();
    await act(async () => {
      await held.current.manage();
    });
    expect(held.current.failure?.message).toBe("No billing account yet.");
    expect(held.current.readFailure).toBeNull();
  });

  test("a customer who genuinely holds nothing reports no read failure", async () => {
    const held = await render(() => useSubscription({ fetch: queue([[200, NOTHING]]) }));
    await settle();
    expect(held.current).toMatchObject({ entitlements: [], subscribed: false, readFailure: null });
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

/**
 * The Paddle half.
 *
 * Every test here injects its own initializer and its own registry. Nothing reaches Paddle's CDN, and no
 * test can leave a loaded Paddle behind for the next — which is what makes "one initialization per page"
 * testable at all rather than an accident of ordering.
 */

/** A sandbox setup. Shaped like Paddle's own publishable token, and obviously not a real one. */
const PADDLE: PaddleSetup = { clientToken: "test_pithyNotARealClientToken", environment: "sandbox" };

/**
 * A Paddle.js that answers `PricePreview` with a recorded sandbox response, and records every checkout.
 *
 * `opened` is an array for the reason `loads` below is: it is read through the object after the fact, and
 * anything that snapshots a number instead of mutating a live one reads zero forever.
 */
function stubPaddle(answer: unknown): PaddleJs & { previews: PaddlePriceQuery[]; opened: PaddleCheckoutOpen[] } {
  const previews: PaddlePriceQuery[] = [];
  const opened: PaddleCheckoutOpen[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview(query: PaddlePriceQuery) {
      previews.push(query);
      return Promise.resolve(answer);
    },
    Checkout: {
      open(options: PaddleCheckoutOpen) {
        opened.push(options);
      },
      close: () => undefined,
    },
    previews,
    opened,
  };
}

/**
 * An initializer that records every load and answers with a fixed outcome.
 *
 * `loads` is an array rather than a counter because a counter has to be read through a live reference,
 * and `Object.assign` copies a getter's *value*. The first version of this helper did exactly that and
 * every load count in this file read zero — including the assertions that were meant to prove a load had
 * not happened. An array is mutated in place, so there is nothing to snapshot wrongly.
 */
function stubInitializer(outcome: PaddleJs | undefined | Error): PaddleInitializer & { loads: string[] } {
  const loads: string[] = [];
  const initialize = (options: { token: string }) => {
    loads.push(options.token);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  };
  return Object.assign(initialize, { loads });
}

/**
 * A Paddle.js whose `PricePreview` answers when the test says so, and in whatever order it says.
 *
 * The overlap defect only exists between two requests that are *both* in flight, so it cannot be seen
 * against a stub that answers as it is asked: every quote there is finished before the next is made, and
 * ordering never comes up. This hands back the resolvers instead, so a test can leave two real promises
 * pending and land them in the wrong order — which is what a slow first answer and a fast second one is.
 */
function slowPaddle(): PaddleJs & {
  previews: PaddlePriceQuery[];
  answer: (index: number, value: unknown) => void;
  refuse: (index: number) => void;
} {
  const previews: PaddlePriceQuery[] = [];
  const pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview(query: PaddlePriceQuery) {
      previews.push(query);
      return new Promise<unknown>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    Checkout: { open: () => undefined, close: () => undefined },
    previews,
    answer: (index, value) => pending[index]?.resolve(value),
    refuse: (index) => pending[index]?.reject(new Error("Paddle refused this quote.")),
  };
}

/** A fresh page for one test. */
function paddlePage(): PaddleRegistry {
  return {};
}

describe("usePaddle", () => {
  test("loads Paddle.js and hands it over", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const held = await render(() => usePaddle(PADDLE, { initialize: stubInitializer(paddle), registry: paddlePage() }));
    await settle();
    expect(held.current).toEqual({ paddle, loading: false, failure: null });
  });

  test("no Paddle rail is nothing to load, not a failure", async () => {
    // `paymentsConfig.paddle` is null when the rail is off. A pricing page for a project that does not
    // sell through Paddle renders its own empty state; it does not show an error about a provider it
    // never asked for. A hook that took no null would force a conditional hook call on the screen.
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const held = await render(() => usePaddle(null, { initialize, registry: paddlePage() }));
    await settle();
    expect(held.current).toEqual({ paddle: null, loading: false, failure: null });
    expect(initialize.loads).toEqual([]);
  });

  test("a blocked script is a renderable failure and never a thrown error", async () => {
    const held = await render(() =>
      usePaddle(PADDLE, { initialize: stubInitializer(new Error("blocked")), registry: paddlePage() }),
    );
    await settle();
    expect(held.current).toEqual({ paddle: null, loading: false, failure: PADDLE_UNAVAILABLE });
  });
});

describe("usePricePreview", () => {
  /** The query every test asks, written inline the way a screen writes it. */
  function query(): PaddlePriceQuery {
    return {
      items: [{ priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh", quantity: 1 }],
      address: { countryCode: "US", postalCode: "10001" },
    };
  }

  test("the first frame is loading with no price — a screen holds the space rather than showing a wrong one", async () => {
    // Never a placeholder figure, and never a blank. A price that arrives a beat late is better than one
    // that corrects itself in front of the buyer.
    const held = await render(() =>
      usePricePreview(PADDLE, query(), {
        initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
        registry: paddlePage(),
      }),
    );
    expect(held.history[0]).toMatchObject({ preview: null, loading: true, failure: null });
  });

  test("the price that lands is the one Paddle quoted for this visitor", async () => {
    const held = await render(() =>
      usePricePreview(PADDLE, query(), {
        initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
        registry: paddlePage(),
      }),
    );
    await settle();
    expect(held.current.loading).toBe(false);
    expect(held.current.preview?.lines[0]?.formattedUnitTotals.total).toBe("$5.44");
    expect(held.current.preview?.lines[0]?.taxTreatment).toBe("added");
  });

  test("a query written inline does not re-quote on every render", async () => {
    // The defect this designs out: `{ items: [...] }` is a new object each render, and an effect
    // depending on it fetches forever. The effect depends on what was asked, not on the object.
    const paddle = stubPaddle(US_NEW_YORK);
    const held = await render(() =>
      usePricePreview(PADDLE, query(), { initialize: stubInitializer(paddle), registry: paddlePage() }),
    );
    await settle();
    await held.rerender();
    await held.rerender();
    await settle();
    expect(paddle.previews).toHaveLength(1);
  });

  test("a changed request does re-quote", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const registry = paddlePage();
    const initialize = stubInitializer(paddle);
    let postalCode = "10001";
    const held = await render(() =>
      usePricePreview(
        PADDLE,
        { items: [{ priceId: "pri_1", quantity: 1 }], address: { countryCode: "US", postalCode } },
        { initialize, registry },
      ),
    );
    await settle();
    postalCode = "60602";
    await held.rerender();
    await settle();
    expect(paddle.previews.map((asked) => asked.address?.postalCode)).toEqual(["10001", "60602"]);
    // One page, one Paddle. Re-quoting is not re-initializing.
    expect(initialize.loads).toEqual([PADDLE.clientToken]);
  });

  test("a failure clears the price and says why — no fallback figure, ever", async () => {
    // Falling back to a hardcoded number reintroduces the whole defect: it is wrong in every country
    // whose convention differs from the one it was written in, and it is wrong silently.
    const held = await render(() =>
      usePricePreview(PADDLE, query(), {
        initialize: stubInitializer(new Error("blocked")),
        registry: paddlePage(),
      }),
    );
    await settle();
    expect(held.current).toMatchObject({ preview: null, loading: false, failure: PADDLE_UNAVAILABLE });
  });

  test("no Paddle rail quotes nothing, without loading and without failing", async () => {
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const held = await render(() => usePricePreview(null, query(), { initialize, registry: paddlePage() }));
    await settle();
    expect(held.current).toMatchObject({ preview: null, loading: false, failure: null });
    expect(initialize.loads).toEqual([]);
  });

  test("refresh asks again", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const held = await render(() =>
      usePricePreview(PADDLE, query(), { initialize: stubInitializer(paddle), registry: paddlePage() }),
    );
    await settle();
    await act(async () => {
      held.current.refresh();
    });
    await settle();
    expect(paddle.previews).toHaveLength(2);
  });

  /**
   * Two quotes in flight at once, landing in the order the network chose rather than the order they were
   * asked in.
   *
   * Both requests here are real and both are pending — the second is fired while the first has not
   * answered, and the first is then answered last. That is the whole defect: nothing about it exists in a
   * stub that resolves as it is called, so it is driven rather than simulated.
   *
   * Narrow, and worth saying why it is still worth fixing: a signed-in customer has one address on file
   * and no reason to race. An anonymous visitor is the case — location resolves under the query, a
   * country picker moves, and the page re-quotes while the first quote is still out. On the one screen
   * whose entire job is showing a correct price.
   *
   * The fix ignores the superseded answer; it does not cancel the request. Paddle.js's `PricePreview`
   * takes no `AbortSignal` and returns a bare promise — there is nothing to cancel, so ignoring is the
   * whole of it.
   */
  describe("two quotes in flight", () => {
    /** Ask for one price at an address, with the query written inline the way a screen writes it. */
    function at(countryCode: string, postalCode: string): PaddlePriceQuery {
      return {
        items: [{ priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh", quantity: 1 }],
        address: { countryCode, postalCode },
      };
    }

    /** Mount against a Paddle that answers on command, and move the visitor's address once. */
    async function overlapping(): Promise<{
      paddle: ReturnType<typeof slowPaddle>;
      held: { current: UsePricePreview };
    }> {
      const paddle = slowPaddle();
      const initialize = stubInitializer(paddle);
      const registry = paddlePage();
      let address = at("US", "10001");
      const held = await render(() => usePricePreview(PADDLE, address, { initialize, registry }));
      await settle();
      address = at("GB", "SW1A 1AA");
      await held.rerender();
      await settle();
      // Both are out, and neither has answered. Without this the rest of the test proves nothing.
      expect(paddle.previews.map((asked) => asked.address?.countryCode)).toEqual(["US", "GB"]);
      return { paddle, held };
    }

    test("the second quote lands first, and the first no longer wins by arriving late", async () => {
      const { paddle, held } = await overlapping();
      await act(async () => {
        paddle.answer(1, GB);
        await Promise.resolve();
      });
      expect(held.current.preview?.countryCode).toBe("GB");

      // The superseded answer arrives. It is for an address this visitor has left.
      await act(async () => {
        paddle.answer(0, US_NEW_YORK);
        await Promise.resolve();
      });
      expect(held.current.preview?.countryCode).toBe("GB");
      expect(held.current.preview?.lines[0]?.formattedUnitTotals.total).toBe("$5.00");
      expect(held.current.loading).toBe(false);
    });

    test("a superseded refusal does not clear the quote that superseded it", async () => {
      // The same defect in its other direction, and the worse one to look at: the stale request fails,
      // and a price the visitor is already reading blanks itself for a request nobody is waiting on.
      const { paddle, held } = await overlapping();
      await act(async () => {
        paddle.answer(1, GB);
        await Promise.resolve();
      });
      await act(async () => {
        paddle.refuse(0);
        await Promise.resolve();
      });
      expect(held.current.preview?.countryCode).toBe("GB");
      expect(held.current.failure).toBeNull();
    });
  });
});

/**
 * The checkout that opens over the page rather than sending the buyer away.
 *
 * The last test in this block is the one worth reading. Inline checkout renders into an element found by
 * class name at the instant `Paddle.Checkout.open` is called, and that instant has to be *after* React
 * has committed the render that revealed it. That ordering cannot be asserted about a function — it only
 * exists in a mounted component — so it is proved by mounting one and letting Paddle look for a real
 * element in a real document.
 */
const HANDOFF = {
  kind: "paddle" as const,
  transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
  clientToken: PADDLE.clientToken,
  environment: "sandbox" as const,
  displayMode: "overlay" as const,
  successUrl: "https://example.test/welcome",
};

/** The class a scaffolded screen gives its inline container. */
const FRAME = "pithy-checkout";

describe("usePaddleCheckout", () => {
  test("no handoff opens nothing, and is not a failure", async () => {
    // The state every screen is in until someone clicks Buy, and the state a screen on a project with no
    // Paddle rail is in forever.
    const paddle = stubPaddle(US_NEW_YORK);
    const initialize = stubInitializer(paddle);
    const held = await render(() => usePaddleCheckout(null, { initialize, registry: paddlePage() }));
    await settle();
    expect(held.current).toEqual({ inline: false, opening: false, failure: null });
    expect(initialize.loads).toEqual([]);
    expect(paddle.opened).toEqual([]);
  });

  test("a handoff is opened once, and a re-render does not open a second checkout over it", async () => {
    // A second overlay over the first is not twice as open. Every render calls this hook again, so the
    // effect has to key on the transaction rather than on the object it arrived in.
    const paddle = stubPaddle(US_NEW_YORK);
    const registry = paddlePage();
    const initialize = stubInitializer(paddle);
    const held = await render(() => usePaddleCheckout(HANDOFF, { initialize, registry, frameTarget: FRAME }));
    await settle();
    expect(paddle.opened).toHaveLength(1);
    await held.rerender();
    await settle();
    expect(paddle.opened).toHaveLength(1);
    expect(held.current).toEqual({ inline: false, opening: false, failure: null });
  });

  test("one mount opens one checkout under StrictMode, which is the mode the scaffolding runs in", async () => {
    // `pithy ui add react` writes a `client.tsx` that wraps the router in `StrictMode`, so in development
    // every effect runs, is cleaned up, and runs again. An effect keyed only on the transaction opened a
    // second checkout over the first on that second pass — for every adopter, on every buy click, in the
    // mode they develop in.
    const paddle = stubPaddle(US_NEW_YORK);
    const held = await render(
      () =>
        usePaddleCheckout(HANDOFF, { initialize: stubInitializer(paddle), registry: paddlePage(), frameTarget: FRAME }),
      { strict: true },
    );
    await settle();
    expect(paddle.opened).toHaveLength(1);
    expect(held.current).toEqual({ inline: false, opening: false, failure: null });
  });

  test("a second attempt is a second transaction, and that one does open", async () => {
    // The guard above must not be a latch on the hook. `start` mints a fresh transaction on every attempt,
    // so a buyer who closed the overlay and clicked Buy again arrives with a new id — and that is a
    // checkout that has to open. A guard keyed on "has opened at all" would swallow it.
    const paddle = stubPaddle(US_NEW_YORK);
    const initialize = stubInitializer(paddle);
    const registry = paddlePage();
    let handoff = HANDOFF;
    const held = await render(() => usePaddleCheckout(handoff, { initialize, registry, frameTarget: FRAME }), {
      strict: true,
    });
    await settle();
    handoff = { ...HANDOFF, transactionId: "txn_01hv8wptq8987qeep44cyrewq0" };
    await held.rerender();
    await settle();
    expect(paddle.opened.map((open) => open.transactionId)).toEqual([
      HANDOFF.transactionId,
      "txn_01hv8wptq8987qeep44cyrewq0",
    ]);
  });

  test("the transaction, the mode and the success URL all come off the handoff", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    await render(() =>
      usePaddleCheckout(HANDOFF, { initialize: stubInitializer(paddle), registry: paddlePage(), frameTarget: FRAME }),
    );
    await settle();
    expect(paddle.opened[0]).toEqual({
      transactionId: HANDOFF.transactionId,
      settings: { displayMode: "overlay", successUrl: HANDOFF.successUrl },
    });
  });

  test("a refusal is a rendered message, not a throw out of an effect", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const held = await render(() =>
      usePaddleCheckout(
        { ...HANDOFF, displayMode: "inline" },
        { initialize: stubInitializer(paddle), registry: paddlePage(), frameTarget: "nothing-renders-this" },
      ),
    );
    await settle();
    expect(held.current).toEqual({ inline: true, opening: false, failure: PADDLE_NO_CONTAINER });
    expect(paddle.opened).toEqual([]);
  });

  test("`inline` is the handoff's mode, so a screen renders its container from the same fact", async () => {
    // Not the screen's own guess at what the project configured. `paddle.checkout` is server-side config
    // resolved into the handoff, and a project switching modes must not also have to edit a screen.
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const overlay = await render(() =>
      usePaddleCheckout(HANDOFF, { initialize, registry: paddlePage(), frameTarget: FRAME }),
    );
    expect(overlay.current.inline).toBe(false);
    const inline = await render(() =>
      usePaddleCheckout(
        { ...HANDOFF, displayMode: "inline" },
        {
          initialize,
          registry: paddlePage(),
          frameTarget: FRAME,
        },
      ),
    );
    expect(inline.current.inline).toBe(true);
  });
});

describe("a screen composing both hooks", () => {
  /** What the screen last rendered with, so a test can drive it and then read it. */
  interface Seen {
    start: (productId: string) => Promise<void>;
    failure: unknown;
    inline: boolean;
  }

  /**
   * The scaffolded screen's shape, in miniature: a buy button, and a container rendered from `inline`.
   *
   * Deliberately not passed a `document` seam. The point is that Paddle looks in the real one, at the
   * moment the effect runs, and finds an element React has actually committed.
   */
  function mount(fetcher: PaymentsFetch, paddle: PaddleJs) {
    const seen = { current: undefined as Seen | undefined };
    const initialize = stubInitializer(paddle);
    const registry = paddlePage();
    function Screen() {
      const checkout = useCheckout({ fetch: fetcher });
      const opened = usePaddleCheckout(checkout.handoff, { initialize, registry, frameTarget: FRAME });
      seen.current = { start: checkout.start, failure: opened.failure ?? checkout.failure, inline: opened.inline };
      return opened.inline ? createElement("div", { className: FRAME }) : null;
    }
    return { seen, render: () => act(async () => root.render(createElement(Screen))) };
  }

  test("inline finds the container the same render put on the page", async () => {
    // The ordering gate. Opening the checkout from the click handler instead of from an effect would run
    // it before React committed the container, Paddle would find no element with the class, and it would
    // render into nothing — silently, which is why this is worth a mounted component to prove.
    const paddle = stubPaddle(US_NEW_YORK);
    const screen = mount(queue([[200, { ...HANDOFF, displayMode: "inline" }]]), paddle);
    await screen.render();
    expect(container.querySelector(`.${FRAME}`)).toBeNull();

    await act(async () => {
      await screen.seen.current?.start("pro_monthly");
    });
    await settle();

    expect(screen.seen.current?.inline).toBe(true);
    expect(container.querySelector(`.${FRAME}`)).not.toBeNull();
    expect(screen.seen.current?.failure).toBeNull();
    expect(paddle.opened).toEqual([
      {
        transactionId: HANDOFF.transactionId,
        settings: {
          displayMode: "inline",
          successUrl: HANDOFF.successUrl,
          frameTarget: FRAME,
          frameStyle: PADDLE_FRAME_STYLE,
          frameInitialHeight: PADDLE_FRAME_HEIGHT,
        },
      },
    ]);
  });

  test("overlay renders no container and still opens", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const screen = mount(queue([[200, HANDOFF]]), paddle);
    await screen.render();
    await act(async () => {
      await screen.seen.current?.start("pro_monthly");
    });
    await settle();
    expect(container.querySelector(`.${FRAME}`)).toBeNull();
    expect(paddle.opened).toHaveLength(1);
    expect(screen.seen.current?.failure).toBeNull();
  });

  test("a redirect rail opens no Paddle at all — the script is never fetched", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const screen = mount(queue([[200, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_1" }]]), paddle);
    await screen.render();
    await act(async () => {
      await screen.seen.current?.start("pro_monthly");
    });
    await settle();
    expect(paddle.opened).toEqual([]);
    expect(screen.seen.current?.inline).toBe(false);
  });
});
