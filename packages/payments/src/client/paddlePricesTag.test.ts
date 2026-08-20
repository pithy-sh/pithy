// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { US_NEW_YORK } from "./fixtures/pricePreview";
import type { PaddleInitializer, PaddleJs, PaddlePriceQuery, PaddleRegistry } from "./paddle";
import type { PaddlePlanQuote } from "./paddlePrices";
import {
  mountPrices,
  PADDLE_PRICES_NOT_CONFIGURED,
  type PaddlePricesTag,
  type PricesDocument,
  paintPlanQuotes,
  readPaddlePricesTag,
} from "./paddlePricesTag";

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

/** The attributes a configured sandbox tag carries. */
const CONFIGURED = {
  "data-paddle-env": "sandbox",
  "data-paddle-token": "test_682bec647f93d37fd95a1b700db",
  "data-paddle-price-solo": "pri_01kzvyz9e21z9vbhd7xqq3csyh",
  "data-paddle-price-team": "pri_01kzvyz9khsdy36z10wb8bgmq4",
};

describe("readPaddlePricesTag", () => {
  test("reads the account and every named plan off the tag", () => {
    expect(readPaddlePricesTag(tag(CONFIGURED))).toEqual({
      setup: { environment: "sandbox", clientToken: "test_682bec647f93d37fd95a1b700db" },
      plans: { solo: "pri_01kzvyz9e21z9vbhd7xqq3csyh", team: "pri_01kzvyz9khsdy36z10wb8bgmq4" },
      paint: true,
    });
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
  { plan: "solo", priceId: "pri_solo", headline: "$5.00", note: "Plus $0.44 tax.", estimated: false },
  { plan: "team", priceId: "pri_team", headline: "$12.00", note: null, estimated: false },
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
  /** A Paddle.js that answers `PricePreview` with the recording. */
  function stubPaddle(answer: unknown): PaddleJs {
    return {
      Initialized: true,
      Environment: { set: () => undefined },
      PricePreview: (_query: PaddlePriceQuery) => Promise.resolve(answer),
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
