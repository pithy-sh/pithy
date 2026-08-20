// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { US_NEW_YORK } from "./fixtures/pricePreview";
import type { PaddleInitializer, PaddleJs, PaddlePriceQuery, PaddleRegistry } from "./paddle";
import type { PaddleCacheStore } from "./paddleCache";
import type { PaddlePlanQuote } from "./paddlePrices";
import {
  mountPrices,
  PADDLE_PRICES_NOT_CONFIGURED,
  type PaddlePricesTag,
  type PricesDocument,
  paintPlanQuotes,
  readPaddlePricesTag,
} from "./paddlePricesTag";
import { memoryStore } from "./test-utils/cacheStore";

/**
 * A real `<script>` carrying exactly these attributes.
 *
 * A real element rather than a stub with two methods, because the thing under test is a *tag* and HTML
 * has opinions a stub does not — an attribute name is lower-cased on the way in, which is why a plan is
 * named in lower case here and on the page.
 */
function tag(attributes: Record<string, string>): PaddlePricesTag {
  const element = document.createElement("script");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** The Paddle customer a signed-in visitor is priced as. An identifier, not a credential. */
const CUSTOMER = "ctm_01kzvyz9pithyNotARealCustomer";

/** The attributes a configured sandbox tag carries. */
const CONFIGURED = {
  "data-paddle-env": "sandbox",
  "data-paddle-token": "test_682bec647f93d37fd95a1b700db",
  "data-paddle-price-solo": "pri_01kzvyz9e21z9vbhd7xqq3csyh",
  "data-paddle-price-team": "pri_01kzvyz9khsdy36z10wb8bgmq4",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPaddlePricesTag", () => {
  test("reads the account and every named plan off the tag", () => {
    expect(readPaddlePricesTag(tag(CONFIGURED))).toEqual({
      setup: { environment: "sandbox", clientToken: "test_682bec647f93d37fd95a1b700db" },
      plans: { solo: "pri_01kzvyz9e21z9vbhd7xqq3csyh", team: "pri_01kzvyz9khsdy36z10wb8bgmq4" },
      paint: true,
      query: {},
      cache: null,
    });
  });

  test("reads the customer to quote as, so a signed-in visitor is priced from the address on file", () => {
    // The dashboard and the marketing site load one artifact. The marketing site knows nobody; the
    // dashboard renders the tag with the caller's own `ctm_…` on it, and Paddle prices them from the
    // address `POST /payments/checkout` will bill.
    const config = readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-customer": CUSTOMER }));

    expect(config?.query).toEqual({ customerId: CUSTOMER });
  });

  test("ignores a customer that is not one, and quotes from the network instead of refusing", () => {
    // The opposite call to the one a placeholder price id gets, and deliberately. A wrong price cannot be
    // recovered from, so a placeholder id refuses the tag. A missing customer costs the visitor an
    // estimate that says it is one — which is what every anonymous visitor already sees.
    for (const customer of ["REPLACE_WITH_CUSTOMER_ID", "", "  "]) {
      expect(readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-customer": customer }))?.query).toEqual({});
    }
  });

  test("takes plan names verbatim after the prefix, so the page's own names reach it", () => {
    const config = readPaddlePricesTag(
      tag({ ...CONFIGURED, "data-paddle-price-team-plus": "pri_01kzvyz9khsdy36z10wb8bgmq5" }),
    );
    expect(config?.plans["team-plus"]).toBe("pri_01kzvyz9khsdy36z10wb8bgmq5");
  });

  test("paints by default", () => {
    expect(readPaddlePricesTag(tag(CONFIGURED))?.paint).toBe(true);
  });

  test('`data-paddle-paint="off"` leaves the page to paint itself', () => {
    expect(readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-paint": "off" }))?.paint).toBe(false);
  });

  test("caches nothing, and says nothing, when the tag asks for no cache", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readPaddlePricesTag(tag(CONFIGURED))?.cache).toBeNull();
    expect(warned).not.toHaveBeenCalled();
  });

  test("takes a cache from the tag: a name, a store, and a lifetime in seconds", () => {
    // Seconds on the attribute, milliseconds in the code. A tag is HTML, and HTML counts a cache in
    // seconds everywhere else it counts one.
    const local = memoryStore();
    const config = readPaddlePricesTag(
      tag({
        ...CONFIGURED,
        "data-paddle-cache": "pricing",
        "data-paddle-cache-store": "local",
        "data-paddle-cache-ttl": "300",
      }),
      { local, session: memoryStore() },
    );

    expect(config?.cache).toEqual({ key: "pricing", store: local, ttlMs: 300_000 });
  });

  test("`session` is the other store a page can name, and they are different stores", () => {
    const session = memoryStore();
    const config = readPaddlePricesTag(
      tag({
        ...CONFIGURED,
        "data-paddle-cache": "pricing",
        "data-paddle-cache-store": "session",
        "data-paddle-cache-ttl": "60",
      }),
      { local: memoryStore(), session },
    );

    expect(config?.cache?.store).toBe(session);
  });

  test("resolves the browser's own stores when nobody injected one, and they are the two it names", () => {
    // The default path, which is the one every real page takes: a tag cannot hand over an object, so
    // `local` and `session` have to land on the browser's own two rather than on one of them twice.
    const resolved = (named: string): PaddleCacheStore | undefined =>
      readPaddlePricesTag(
        tag({
          ...CONFIGURED,
          "data-paddle-cache": "pricing",
          "data-paddle-cache-store": named,
          "data-paddle-cache-ttl": "60",
        }),
      )?.cache?.store;

    expect(resolved("local")).toBe(globalThis.localStorage as unknown as PaddleCacheStore);
    expect(resolved("session")).toBe(globalThis.sessionStorage as unknown as PaddleCacheStore);
    expect(resolved("local")).not.toBe(resolved("session"));
  });

  test("caches nothing when the browser refuses to hand over the store at all", () => {
    // Reaching for `localStorage` **throws** where a browser has storage switched off, or inside a
    // sandboxed frame that denies it. A pricing page must not take that exception on the way to asking
    // Paddle a question it could have asked anyway.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is disabled");
      },
    });
    try {
      const config = readPaddlePricesTag(
        tag({
          ...CONFIGURED,
          "data-paddle-cache": "pricing",
          "data-paddle-cache-store": "local",
          "data-paddle-cache-ttl": "60",
        }),
      );

      expect(config).not.toBeNull();
      expect(config?.cache).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      if (held === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", held);
    }
  });

  test("warns and caches nothing when the tag names a cache but no store and no lifetime", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-cache": "pricing" }));

    expect(config?.cache).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("warns about a mistyped store even when it is the only cache attribute on the tag", () => {
    // `localStorage` for `local` is the likely typo, and it used to be indistinguishable from a tag that
    // asked for no cache at all: the resolved store was null either way, so the "did anyone ask?" check
    // saw nothing and said nothing. A caller who names a store has asked.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-cache-store": "localStorage" }));

    expect(config?.cache).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("takes an explicit null store as `this environment has none`, not as `use the browser's`", () => {
    // The type says `PaddleCacheStore | null`, so null has to mean something. It means what it says —
    // an SSR-safe wrapper or a suite declaring there is no storage here, which must not quietly resolve
    // to the real `localStorage` and exercise the opposite path from the one it named.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = readPaddlePricesTag(
      tag({
        ...CONFIGURED,
        "data-paddle-cache": "pricing",
        "data-paddle-cache-store": "local",
        "data-paddle-cache-ttl": "60",
      }),
      { local: null, session: null },
    );

    expect(config?.cache).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("warns and caches nothing when the tag names a store that is not one of the two", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = readPaddlePricesTag(
      tag({
        ...CONFIGURED,
        "data-paddle-cache": "pricing",
        "data-paddle-cache-store": "database",
        "data-paddle-cache-ttl": "60",
      }),
    );

    expect(config?.cache).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("warns and caches nothing when the lifetime is not a number of seconds", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = readPaddlePricesTag(
      tag({
        ...CONFIGURED,
        "data-paddle-cache": "pricing",
        "data-paddle-cache-store": "local",
        "data-paddle-cache-ttl": "soon",
      }),
      { local: memoryStore(), session: memoryStore() },
    );

    expect(config?.cache).toBeNull();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  test("still refuses the tag outright when a price id is a placeholder, cache or no cache", () => {
    expect(
      readPaddlePricesTag(
        tag({
          ...CONFIGURED,
          "data-paddle-price-team": "REPLACE_WITH_TEAM_PRICE_ID",
          "data-paddle-cache": "pricing",
          "data-paddle-cache-store": "local",
          "data-paddle-cache-ttl": "60",
        }),
      ),
    ).toBeNull();
  });

  test("refuses when there is no tag at all", () => {
    expect(readPaddlePricesTag(null)).toBeNull();
  });

  test("refuses a tag carrying no token", () => {
    const { "data-paddle-token": _token, ...rest } = CONFIGURED;
    expect(readPaddlePricesTag(tag(rest))).toBeNull();
  });

  test("refuses a placeholder token, rather than asking Paddle about it", () => {
    expect(
      readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-token": "REPLACE_WITH_LIVE_CLIENT_TOKEN" })),
    ).toBeNull();
  });

  test("refuses a tag naming no environment", () => {
    const { "data-paddle-env": _env, ...rest } = CONFIGURED;
    expect(readPaddlePricesTag(tag(rest))).toBeNull();
  });

  test("refuses an environment that is not one of Paddle's two accounts", () => {
    expect(readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-env": "staging" }))).toBeNull();
  });

  test("refuses a sandbox tag holding a live token, and the reverse", () => {
    expect(
      readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-token": "live_682bec647f93d37fd95a1b700db" })),
    ).toBeNull();
    expect(readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-env": "production" }))).toBeNull();
  });

  test("refuses the whole tag when one plan's id is still a placeholder", () => {
    expect(
      readPaddlePricesTag(tag({ ...CONFIGURED, "data-paddle-price-team": "REPLACE_WITH_LIVE_TEAM_PRICE_ID" })),
    ).toBeNull();
  });

  test("refuses a tag that names no plan", () => {
    const { "data-paddle-price-solo": _solo, "data-paddle-price-team": _team, ...rest } = CONFIGURED;
    expect(readPaddlePricesTag(tag(rest))).toBeNull();
  });
});

/** Two plans, quoted. */
const QUOTED: readonly PaddlePlanQuote[] = [
  { plan: "solo", priceId: "pri_solo", headline: "$5.00", note: "Plus $0.44 tax.", estimated: false, currency: "USD" },
  { plan: "team", priceId: "pri_team", headline: "$12.00", note: null, estimated: false, currency: "USD" },
];

/** A page carrying one slot per named plan, each holding the sentence the site shipped with. */
function pricingPage(...plans: string[]): void {
  document.body.innerHTML = plans
    .map(
      (plan) => `<p data-price-plan="${plan}">Priced where you are billed</p><small data-price-note="${plan}"></small>`,
    )
    .join("");
}

/** What each plan slot on the page now reads. */
function painted(): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const node of document.querySelectorAll("[data-price-plan]")) {
    slots[node.getAttribute("data-price-plan") ?? ""] = node.textContent ?? "";
  }
  return slots;
}

/** What each tax-sentence slot on the page now reads. */
function notes(): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const node of document.querySelectorAll("[data-price-note]")) {
    slots[node.getAttribute("data-price-note") ?? ""] = node.textContent ?? "";
  }
  return slots;
}

describe("paintPlanQuotes", () => {
  test("writes each plan's headline into the slot that names it", () => {
    pricingPage("solo", "team");
    paintPlanQuotes(document, QUOTED);
    expect(painted()).toEqual({ solo: "$5.00", team: "$12.00" });
  });

  test("writes the tax sentence beside it, so a figure tax is added to does not read as the price", () => {
    pricingPage("solo", "team");
    paintPlanQuotes(document, QUOTED);
    expect(notes()).toEqual({ solo: "Plus $0.44 tax.", team: "" });
  });

  test("leaves a slot no quote names holding the sentence the page shipped with", () => {
    pricingPage("solo", "enterprise");
    paintPlanQuotes(document, QUOTED);
    expect(painted().enterprise).toBe("Priced where you are billed");
  });

  test("matches a slot however it was cased, because a tag can only name a plan in lower case", () => {
    pricingPage("teamPlus");
    paintPlanQuotes(document, [{ ...QUOTED[1], plan: "teamplus" }] as readonly PaddlePlanQuote[]);
    expect(painted().teamPlus).toBe("$12.00");
  });
});

describe("mountPrices", () => {
  /** A Paddle.js that answers `PricePreview` with the recording, and records what it was asked. */
  function stubPaddle(answer: unknown): PaddleJs & { previews: PaddlePriceQuery[] } {
    const previews: PaddlePriceQuery[] = [];
    return {
      previews,
      Initialized: true,
      Environment: { set: () => undefined },
      PricePreview: (query: PaddlePriceQuery) => {
        previews.push(query);
        return Promise.resolve(answer);
      },
      Checkout: {
        open: () => {
          throw new Error("no test in pricesTag.test.ts opens a checkout");
        },
        close: () => undefined,
      },
    };
  }

  /** An initializer that answers with a fixed Paddle and records the token it was asked for. */
  function stubInitializer(paddle: PaddleJs): PaddleInitializer & { loads: string[] } {
    const loads: string[] = [];
    const initialize = (options: { token: string }) => {
      loads.push(options.token);
      return Promise.resolve(paddle);
    };
    return Object.assign(initialize, { loads });
  }

  /** A fresh page for one test. Nothing here touches the module's own. */
  function page(): PaddleRegistry {
    return {};
  }

  /** The tag the recording answers for. */
  const SOLO_TAG = {
    "data-paddle-env": "sandbox",
    "data-paddle-token": "test_pithyNotARealClientToken",
    "data-paddle-price-solo": "pri_01kzvyz9e21z9vbhd7xqq3csyh",
  };

  test("quotes the tag's plans and paints them", async () => {
    pricingPage("solo");
    const result = await mountPrices(document, tag(SOLO_TAG), {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
    });

    expect(result.ok && result.value.map((quote) => quote.headline)).toEqual(["$5.00"]);
    expect(painted()).toEqual({ solo: "$5.00" });
  });

  test("hands back the quotes without painting when the page said it paints itself", async () => {
    pricingPage("solo");
    const result = await mountPrices(document, tag({ ...SOLO_TAG, "data-paddle-paint": "off" }), {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
    });

    expect(result.ok && result.value.map((quote) => quote.headline)).toEqual(["$5.00"]);
    expect(painted()).toEqual({ solo: "Priced where you are billed" });
  });

  test("asks Paddle about the customer the tag named, so the dashboard's figure is the charged one", async () => {
    pricingPage("solo");
    const paddle = stubPaddle(US_NEW_YORK);
    await mountPrices(document, tag({ ...SOLO_TAG, "data-paddle-customer": CUSTOMER }), {
      initialize: stubInitializer(paddle),
      registry: page(),
    });

    expect(paddle.previews).toEqual([
      { items: [{ priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh", quantity: 1 }], customerId: CUSTOMER },
    ]);
  });

  test("a caller's own query fills in beside the tag's, rather than replacing it", async () => {
    // The dashboard server-renders the customer onto the tag and a screen may still know something the
    // markup does not — a country the visitor picked, say. Replacing the tag's half wholesale would drop
    // the `customerId` and quote from the network again, which is the defect this whole change removes.
    pricingPage("solo");
    const paddle = stubPaddle(US_NEW_YORK);
    await mountPrices(document, tag({ ...SOLO_TAG, "data-paddle-customer": CUSTOMER }), {
      initialize: stubInitializer(paddle),
      registry: page(),
      query: { address: { countryCode: "US", postalCode: "10001" } },
    });

    expect(paddle.previews).toEqual([
      {
        items: [{ priceId: "pri_01kzvyz9e21z9vbhd7xqq3csyh", quantity: 1 }],
        customerId: CUSTOMER,
        address: { countryCode: "US", postalCode: "10001" },
      },
    ]);
  });

  test("asks Paddle once across two mounts when the tag named a cache, and paints both", async () => {
    // The marketing site's second page, and the dashboard's second mount of its pricing pane. One
    // artifact, one store, one round trip.
    const cached = {
      ...SOLO_TAG,
      "data-paddle-cache": "pricing",
      "data-paddle-cache-store": "local",
      "data-paddle-cache-ttl": "300",
    };
    const stores = { local: memoryStore(), session: memoryStore() };

    pricingPage("solo");
    await mountPrices(document, tag(cached), {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      stores,
    });

    pricingPage("solo");
    const second = stubInitializer(stubPaddle(US_NEW_YORK));
    const result = await mountPrices(document, tag(cached), { initialize: second, registry: page(), stores });

    expect(second.loads).toEqual([]);
    expect(result.ok && result.value.map((quote) => quote.headline)).toEqual(["$5.00"]);
    expect(painted()).toEqual({ solo: "$5.00" });
  });

  test("one visitor's cached price is never handed to another", async () => {
    // The customer is inside the key the entry rests under, so the dashboard caching a signed-in price
    // cannot serve it to the next person on a shared machine.
    const cached = {
      ...SOLO_TAG,
      "data-paddle-cache": "pricing",
      "data-paddle-cache-store": "local",
      "data-paddle-cache-ttl": "300",
    };
    const stores = { local: memoryStore(), session: memoryStore() };

    pricingPage("solo");
    await mountPrices(document, tag({ ...cached, "data-paddle-customer": CUSTOMER }), {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      stores,
    });

    pricingPage("solo");
    const other = stubInitializer(stubPaddle(US_NEW_YORK));
    await mountPrices(document, tag({ ...cached, "data-paddle-customer": "ctm_01kzvyz9pithySomebodyElse" }), {
      initialize: other,
      registry: page(),
      stores,
    });

    expect(other.loads).toHaveLength(1);
  });

  test("an unconfigured tag loads nothing, paints nothing, and says which attributes are missing", async () => {
    pricingPage("solo");
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const result = await mountPrices(document, tag({ ...SOLO_TAG, "data-paddle-token": "REPLACE_ME" }), {
      initialize,
      registry: page(),
    });

    expect(result).toEqual({ ok: false, failure: PADDLE_PRICES_NOT_CONFIGURED });
    expect(initialize.loads).toEqual([]);
    expect(painted()).toEqual({ solo: "Priced where you are billed" });
  });

  test("waits for the page's own slots when it was loaded before them", async () => {
    // A third-party tag's usual home is `<head>`, where the body it paints into does not exist yet. The
    // quote starts anyway — the round trip overlaps parsing, which is the whole reason to load early —
    // but the paint waits for the slots.
    document.body.innerHTML = "";
    const listeners: (() => void)[] = [];
    const loading: PricesDocument = {
      readyState: "loading",
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      querySelectorAll: (selectors: string) => document.querySelectorAll(selectors),
    };

    const mounted = mountPrices(loading, tag(SOLO_TAG), {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
    });
    // Every microtask the quote takes, drained. A paint that did not wait has happened by now, into a
    // page with no slots in it at all.
    await new Promise((resolve) => setTimeout(resolve, 0));

    pricingPage("solo");
    for (const listener of listeners) listener();

    const result = await mounted;
    expect(result.ok).toBe(true);
    expect(painted()).toEqual({ solo: "$5.00" });
  });

  test("a refused quote leaves every sentence the page shipped with standing", async () => {
    pricingPage("solo");
    const result = await mountPrices(document, tag(SOLO_TAG), {
      initialize: stubInitializer(stubPaddle({ data: { currencyCode: "USD" } })),
      registry: page(),
    });

    expect(result.ok).toBe(false);
    expect(painted()).toEqual({ solo: "Priced where you are billed" });
  });
});
