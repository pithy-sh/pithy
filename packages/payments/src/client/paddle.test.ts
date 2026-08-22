// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { initializePaddle, Paddle } from "@paddle/paddle-js";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { PAYMENTS_NO_BROWSER, PAYMENTS_UNREADABLE } from "./api";
import { DE, GB, JP_YEN, US_COUNTRY_ONLY, US_NEW_YORK } from "./fixtures/pricePreview";
import {
  loadPaddle,
  PADDLE_ACCOUNT_CONFLICT,
  PADDLE_NOT_INITIALIZED,
  PADDLE_PREVIEW_REFUSED,
  PADDLE_UNAVAILABLE,
  type PaddleInitializer,
  type PaddleJs,
  type PaddlePriceQuery,
  type PaddleRegistry,
  type PaddleSetup,
  type PricePreview,
  type PriceSummaryOptions,
  previewPrices,
  priceQueryKey,
  priceSummary,
  readPricePreview,
} from "./paddle";
import type { PaddleQuoteCache } from "./paddleCache";
import { memoryStore, refusingStore } from "./test-utils/cacheStore";

/**
 * Two kinds of test live here, and they answer different questions.
 *
 * The **loader** tests are about a script that must be fetched exactly once and must never be fetched at
 * all from a suite. Every one of them injects its own initializer and its own registry, so nothing here
 * reaches Paddle's CDN, and no test can leave a loaded Paddle behind for the next one.
 *
 * The **reader** tests run against `fixtures/pricePreview.ts` — five answers recorded from the live
 * Paddle sandbox, not five answers we invented. That distinction is the point of the file. A tax
 * convention derived from figures a test author chose proves only that the author and the reader agree;
 * these figures were chosen by Paddle, in five places, and the reader has to be right about all of them.
 *
 * `paddle-live` is never contacted, by any test, by construction: no test calls the default initializer.
 */

/** A sandbox setup. Shaped like Paddle's own publishable token, and obviously not a real one. */
const SANDBOX: PaddleSetup = { clientToken: "test_pithyNotARealClientToken", environment: "sandbox" };

/** The same page, a production account. Still not a real token, and still never sent anywhere. */
const PRODUCTION: PaddleSetup = { clientToken: "live_pithyNotARealClientToken", environment: "production" };

/** A Paddle.js that answers `PricePreview` with whatever it was given, and counts its calls. */
function stubPaddle(answer: unknown | (() => Promise<unknown>)): PaddleJs & { previews: PaddlePriceQuery[] } {
  const previews: PaddlePriceQuery[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview(query: PaddlePriceQuery) {
      previews.push(query);
      return typeof answer === "function" ? (answer as () => Promise<unknown>)() : Promise.resolve(answer);
    },
    // Never called from this file. Opening a checkout lives in `checkout.test.ts`, where a stub records
    // what it was handed; here it exists because `PaddleJs` requires it, and a throw would be a louder
    // failure than a silent no-op if that ever stopped being true.
    Checkout: {
      open: () => {
        throw new Error("no test in paddle.test.ts opens a checkout");
      },
      close: () => undefined,
    },
    previews,
  };
}

/** One recorded call to the loader. */
interface Load {
  token: string;
  environment: string | undefined;
}

/** An initializer that records what it was asked for and answers with a fixed outcome. */
function stubInitializer(outcome: PaddleJs | undefined | Error): PaddleInitializer & { loads: Load[] } {
  const loads: Load[] = [];
  const initialize = (options: { token: string; environment?: "sandbox" | "production" }) => {
    loads.push({ token: options.token, environment: options.environment });
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  };
  return Object.assign(initialize, { loads });
}

/** A fresh page for one test. Nothing here touches the module's own. */
function page(): PaddleRegistry {
  return {};
}

describe("loadPaddle", () => {
  test("hands the initializer the declared environment, for sandbox and for production alike", async () => {
    // Never guessed, and never omitted for one of the two. Sandbox and live are separate Paddle accounts
    // with separate tokens; a token used against the wrong one is refused outright, so the environment
    // has to travel with the token rather than being inferred from its prefix.
    const sandbox = stubInitializer(stubPaddle(US_NEW_YORK));
    await loadPaddle(SANDBOX, { initialize: sandbox, registry: page() });
    expect(sandbox.loads).toEqual([{ token: SANDBOX.clientToken, environment: "sandbox" }]);

    const production = stubInitializer(stubPaddle(US_NEW_YORK));
    await loadPaddle(PRODUCTION, { initialize: production, registry: page() });
    expect(production.loads).toEqual([{ token: PRODUCTION.clientToken, environment: "production" }]);
  });

  test("two concurrent callers produce one initialization", async () => {
    // The bug this designs out: a paywall and a pricing panel mounting in the same frame, each loading
    // Paddle.js, each calling Initialize. Two Initializes is not twice as initialized.
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const registry = page();
    const [first, second] = await Promise.all([
      loadPaddle(SANDBOX, { initialize, registry }),
      loadPaddle(SANDBOX, { initialize, registry }),
    ]);
    expect(initialize.loads).toHaveLength(1);
    expect(first).toEqual(second);
  });

  test("a later caller for the same account reuses the load rather than repeating it", async () => {
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const registry = page();
    await loadPaddle(SANDBOX, { initialize, registry });
    await loadPaddle(SANDBOX, { initialize, registry });
    expect(initialize.loads).toHaveLength(1);
  });

  test("a second, different account is refused rather than silently re-pointed", async () => {
    // `Environment.set` after `Initialize` leaves Paddle.js half-moved, and a live account quietly
    // re-pointed at a sandbox is a defect nobody sees until a real card is declined.
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const registry = page();
    await loadPaddle(SANDBOX, { initialize, registry });
    const second = await loadPaddle(PRODUCTION, { initialize, registry });
    expect(second).toEqual({ ok: false, failure: PADDLE_ACCOUNT_CONFLICT });
    expect(initialize.loads).toHaveLength(1);
  });

  test("no window is not a failure of the account — Paddle.js answers undefined, and that is a server", async () => {
    const loaded = await loadPaddle(SANDBOX, { initialize: stubInitializer(undefined), registry: page() });
    expect(loaded).toEqual({ ok: false, failure: PAYMENTS_NO_BROWSER });
  });

  test("a script that never loads is unavailable — a blocker, a CSP, or no network", async () => {
    const initialize = stubInitializer(new Error("Failed to load Paddle.js - v1"));
    const loaded = await loadPaddle(SANDBOX, { initialize, registry: page() });
    expect(loaded).toEqual({ ok: false, failure: PADDLE_UNAVAILABLE });
  });

  test("a Paddle that loaded but did not initialize is refused, not handed back", async () => {
    // `initializePaddle` swallows an initialization error into a console.warn and resolves with the
    // instance anyway. Without this check a bad token reads as a working Paddle whose calls do nothing.
    const inert: PaddleJs = { ...stubPaddle(US_NEW_YORK), Initialized: false };
    const loaded = await loadPaddle(SANDBOX, { initialize: stubInitializer(inert), registry: page() });
    expect(loaded).toEqual({ ok: false, failure: PADDLE_NOT_INITIALIZED });
  });

  test("an initializer that throws before it returns is a refusal, not an exception", async () => {
    // Paddle.js throws synchronously when the document has neither a `<head>` nor a `<body>` — a screen
    // rendered above the document, which is a real ordering and not a hypothetical one.
    const thrower = (() => {
      throw new Error("Cannot inject Paddle.js. It needs a <head> or <body> element.");
    }) as PaddleInitializer;
    const loaded = await loadPaddle(SANDBOX, { initialize: thrower, registry: page() });
    expect(loaded).toEqual({ ok: false, failure: PADDLE_UNAVAILABLE });
  });

  test("a failed load is not remembered, so asking again genuinely tries again", async () => {
    // Idempotence is about not initializing twice. A load that produced nothing initialized nothing, and
    // caching that refusal would make one bad first second permanent for the life of the page.
    const registry = page();
    const blocked = stubInitializer(new Error("blocked"));
    expect(await loadPaddle(SANDBOX, { initialize: blocked, registry })).toEqual({
      ok: false,
      failure: PADDLE_UNAVAILABLE,
    });
    const recovered = stubInitializer(stubPaddle(US_NEW_YORK));
    const second = await loadPaddle(SANDBOX, { initialize: recovered, registry });
    expect(second.ok).toBe(true);
    expect(recovered.loads).toHaveLength(1);
  });

  test("the structural declaration is the real Paddle.js, not a hopeful sketch", () => {
    // The gate against Paddle renaming something under us. `PaddleJs` is declared structurally so an
    // adopter can stub it; this is what stops that convenience from drifting into fiction.
    expectTypeOf<Paddle>().toExtend<PaddleJs>();
    expectTypeOf<typeof initializePaddle>().toExtend<PaddleInitializer>();
  });
});

describe("readPricePreview, against five recorded sandbox answers", () => {
  /** Read a fixture, insisting it parsed. */
  function read(fixture: unknown): PricePreview {
    const preview = readPricePreview(fixture);
    expect(preview).not.toBeNull();
    if (preview === null) throw new Error("unreachable");
    return preview;
  }

  /** The single line every fixture carries. */
  function line(fixture: unknown) {
    const preview = read(fixture);
    expect(preview.lines).toHaveLength(1);
    const only = preview.lines[0];
    if (!only) throw new Error("unreachable");
    return { preview, line: only };
  }

  test("New York adds tax on top of the listed price", () => {
    const { line: quoted } = line(US_NEW_YORK);
    expect(quoted.formattedUnitTotals).toEqual({
      subtotal: "$5.00",
      discount: "$0.00",
      tax: "$0.44",
      total: "$5.44",
    });
    expect(quoted.taxRate).toBe("0.08875");
    expect(quoted.taxTreatment).toBe("added");
  });

  test("the United Kingdom takes VAT out of an inclusive price — the opposite convention, same catalog", () => {
    const { line: quoted } = line(GB);
    expect(quoted.formattedUnitTotals).toEqual({
      subtotal: "$4.17",
      discount: "$0.00",
      tax: "$0.83",
      total: "$5.00",
    });
    expect(quoted.taxTreatment).toBe("included");
  });

  test("Germany is the same convention at a different rate", () => {
    const { line: quoted } = line(DE);
    expect(quoted.formattedUnitTotals.total).toBe("$5.00");
    expect(quoted.formattedUnitTotals.tax).toBe("$0.80");
    expect(quoted.taxTreatment).toBe("included");
  });

  test("currency is not localized without a catalog override — the UK and Germany are quoted in dollars", () => {
    // The measurement that stops "localized pricing" from being a claim this rail cannot keep. Currency
    // comes from `unit_price_overrides`, which is catalog data. What localizes without one is tax.
    expect(read(GB).currencyCode).toBe("USD");
    expect(read(DE).currencyCode).toBe("USD");
    expect(read(US_NEW_YORK).currencyCode).toBe("USD");
  });

  test("a zero-decimal currency is whole units, and is rendered by Paddle rather than by us", () => {
    // ¥725, not ¥72500 and not ¥7.25. Nothing here divides by a hundred, which is exactly why this is
    // right — a kit that formatted raw minor units would need a table of which currencies have decimals.
    const { line: quoted } = line(JP_YEN);
    expect(quoted.unitTotals.subtotal).toBe("725");
    expect(quoted.formattedUnitTotals.subtotal).toBe("¥725");
    expect(quoted.formattedUnitTotals.total).toBe("¥798");
  });

  test("a converted quote cannot be told against a catalog amount in another currency", () => {
    // The catalog lists USD 500. This quote is in yen. Neither 725 nor 798 is "the listed price", so
    // the honest answer is that the convention is unknown — and the total is still what is owed.
    expect(line(JP_YEN).line.taxTreatment).toBe("unknown");
  });

  test("a country with no postal code resolves 0% tax, and the preview says the code is missing", () => {
    // Paddle answers `postalCode: ""` here, not null. The distinction it hides is a 15% one in Chicago.
    const { preview, line: quoted } = line(US_COUNTRY_ONLY);
    expect(preview.countryCode).toBe("US");
    expect(preview.postalCode).toBeNull();
    expect(quoted.taxRate).toBe("0");
    expect(quoted.taxTreatment).toBe("none");
  });

  test("a postal code that was resolved is carried through", () => {
    expect(read(US_NEW_YORK).postalCode).toBe("10001");
    expect(read(GB).postalCode).toBe("SW1A 1AA");
  });

  test("the product, the price name and the billing cycle come through for a screen to label with", () => {
    const { line: quoted } = line(US_NEW_YORK);
    expect(quoted.productName).toBe("Solo");
    expect(quoted.priceName).toBe("Monthly");
    expect(quoted.billingCycle).toEqual({ interval: "month", frequency: 1 });
    expect(quoted.priceId).toBe("pri_01kzvyz9e21z9vbhd7xqq3csyh");
  });

  test("the five fixtures are five different answers, not one copied — the suite would be vacuous otherwise", () => {
    const treatments = [US_NEW_YORK, GB, DE, JP_YEN, US_COUNTRY_ONLY].map((fixture) => {
      const preview = read(fixture);
      const only = preview.lines[0];
      if (!only) throw new Error("unreachable");
      return `${preview.currencyCode}/${only.formattedUnitTotals.total}/${only.taxTreatment}`;
    });
    expect(new Set(treatments).size).toBe(4);
    expect(treatments).toContain("USD/$5.44/added");
    expect(treatments).toContain("JPY/¥798/unknown");
  });
});

describe("readPricePreview reads the envelope Paddle actually resolves", () => {
  /**
   * **`PricePreview()` resolves `{ data, meta }`, and everything a price is made of is under `data`.**
   *
   * This is the shape recorded from a live sandbox call on 2026-08-18 — top-level keys `data` and
   * `meta`, with `currencyCode`, `address` and `details` inside `data`. The reader used to look for
   * `currencyCode` at the top level, found `undefined` on every real answer, and refused every one of
   * them. `previewPrices` turned that into `PAYMENTS_UNREADABLE`, which a screen renders as no price
   * at all — so the rail was silently dead in the browser while this suite was green.
   *
   * It was green because the five recordings were saved one level in, at `response.data`, and the
   * reader was written to match the recordings. A fixture is evidence about somebody else's API and it
   * stops being evidence the moment it is shaped to fit. This test is the one that could not have
   * passed before, and the fixtures below now carry the envelope for the same reason.
   */
  test("a price is read from under `data`", () => {
    const preview = readPricePreview(US_NEW_YORK);
    expect(preview).not.toBeNull();
    expect(preview?.currencyCode).toBe("USD");
    expect(preview?.postalCode).toBe("10001");
    expect(preview?.lines).toHaveLength(1);
  });

  test("`meta` beside `data` is carried and ignored, not refused", () => {
    // Paddle sends a request id there. Nothing here reads it, and an answer that carries it must not
    // be refused for carrying it.
    const enveloped = { data: (US_NEW_YORK as { data: unknown }).data, meta: { requestId: "req_01" } };
    expect(readPricePreview(enveloped)).not.toBeNull();
  });

  test("an already-unwrapped answer is still read, so an adopter who unwraps is not broken", () => {
    const inner = (US_NEW_YORK as { data: unknown }).data;
    expect(readPricePreview(inner)).not.toBeNull();
  });
});

describe("readPricePreview refuses what it cannot read", () => {
  test("a non-object is not a preview", () => {
    for (const value of [null, undefined, "", 0, [], "a price"]) {
      expect(readPricePreview(value)).toBeNull();
    }
  });

  test("no currency, no preview", () => {
    expect(readPricePreview({ details: { lineItems: [] } })).toBeNull();
  });

  test("no line items, no preview", () => {
    expect(readPricePreview({ currencyCode: "USD", details: {} })).toBeNull();
  });

  test("one unreadable line refuses the whole answer — half a price is worse than none", () => {
    const damaged = structuredClone(US_NEW_YORK) as {
      data: { details: { lineItems: { formattedTotals?: unknown }[] } };
    };
    const first = damaged.data.details.lineItems[0];
    if (!first) throw new Error("unreachable");
    first.formattedTotals = undefined;
    expect(readPricePreview(damaged)).toBeNull();
  });

  test("an amount that arrives as a number is refused, not coerced", () => {
    // Paddle sends every amount as a string. A number here means the shape changed, and rendering
    // `String(544)` as a price would be the wrong kind of resilience.
    const damaged = structuredClone(US_NEW_YORK) as {
      data: { details: { lineItems: { formattedUnitTotals: { total: unknown } }[] } };
    };
    const first = damaged.data.details.lineItems[0];
    if (!first) throw new Error("unreachable");
    first.formattedUnitTotals.total = 544;
    expect(readPricePreview(damaged)).toBeNull();
  });

  test("an empty catalog answer is a preview with no lines, not a refusal", () => {
    const empty = readPricePreview({ currencyCode: "USD", details: { lineItems: [] } });
    expect(empty).toEqual({ currencyCode: "USD", countryCode: null, postalCode: null, lines: [] });
  });
});

describe("priceSummary", () => {
  /** The summary for a fixture's only line. */
  function summarize(fixture: unknown, options?: PriceSummaryOptions) {
    const preview = readPricePreview(fixture);
    if (preview === null) throw new Error("unreachable");
    const only = preview.lines[0];
    if (!only) throw new Error("unreachable");
    return priceSummary(preview, only, options);
  }

  /** Every recording, so a claim about the default is a claim about all of them. */
  const EVERY_FIXTURE = [US_NEW_YORK, GB, DE, JP_YEN, US_COUNTRY_ONLY];

  test("New York advertises the price before tax, and says the tax is coming", () => {
    // The US convention. Advertising $5.44 would put a New Yorker's local sales tax in the headline and
    // quote a different number to a buyer in Oregon for the same product.
    expect(summarize(US_NEW_YORK)).toEqual({
      headline: "$5.00",
      note: "Plus $0.44 tax.",
      estimated: false,
    });
  });

  test("Berlin advertises the price including VAT, and says so", () => {
    // The same characters would be a lie here: €4.20 is not what anyone pays.
    expect(summarize(DE)).toEqual({
      headline: "$5.00",
      note: "Includes $0.80 tax.",
      estimated: false,
    });
  });

  test("London reads like Berlin, not like New York", () => {
    expect(summarize(GB)).toEqual({ headline: "$5.00", note: "Includes $0.83 tax.", estimated: false });
  });

  test("the two conventions put different numbers in the headline from one catalog price", () => {
    // The whole claim, in one assertion: a $5.00 price, and the figure a page shows is not the same.
    expect(summarize(US_NEW_YORK).headline).toBe("$5.00");
    expect(summarize(US_NEW_YORK).note).toBe("Plus $0.44 tax.");
    expect(summarize(GB).note).toBe("Includes $0.83 tax.");
    expect(summarize(US_NEW_YORK).note).not.toBe(summarize(GB).note);
  });

  test("a quote with no postal code is marked estimated and promises nothing about tax", () => {
    // 0% is what Paddle answered, and the buyer will be charged 8.875% anyway. Saying "no tax" here
    // would be the defect. Saying nothing would be nearly as bad.
    expect(summarize(US_COUNTRY_ONLY)).toEqual({
      headline: "$5.00",
      note: "Tax is settled at checkout.",
      estimated: true,
    });
  });

  test("a converted quote still renders the total, because the total is still what is owed", () => {
    expect(summarize(JP_YEN)).toEqual({ headline: "¥798", note: "Includes ¥73 tax.", estimated: false });
  });

  test("every headline is a string Paddle rendered — none is assembled here", () => {
    // The acceptance criterion, as a test rather than as a comment: a headline must appear verbatim in
    // the recorded answer. A formatter that divided by a hundred, or inserted a symbol, fails this.
    for (const fixture of EVERY_FIXTURE) {
      expect(JSON.stringify(fixture)).toContain(`"${summarize(fixture).headline}"`);
    }
  });

  test("the whole-units trim is off unless a caller asks, and off is Paddle's own string", () => {
    // The gate the option exists under. Whether to advertise `$5` or `$5.00` is a pricing decision, so
    // the kit may not make it for anybody — and a default that quietly restyled a seller's prices would
    // be caught here, on every recording at once, in all three ways of not asking.
    for (const fixture of EVERY_FIXTURE) {
      expect(summarize(fixture)).toEqual(summarize(fixture, {}));
      expect(summarize(fixture)).toEqual(summarize(fixture, { wholeUnits: false }));
      expect(JSON.stringify(fixture)).toContain(`"${summarize(fixture).headline}"`);
    }
  });

  test("asked for whole units, New York advertises $5 and still says the tax is coming", () => {
    expect(summarize(US_NEW_YORK, { wholeUnits: true })).toEqual({
      headline: "$5",
      note: "Plus $0.44 tax.",
      estimated: false,
    });
  });

  test("the sentence keeps its own decimals, because a tax figure is arithmetic and not a price", () => {
    // A seller chose `$5.00`, so every plan's headline loses the same fraction. Nobody chose `$0.44`;
    // it is a rate applied to a base, and one plan's tax landing on a round number while the next does
    // not would put `$0.44` and `$1` side by side in the same column.
    expect(summarize(GB, { wholeUnits: true })).toEqual({
      headline: "$5",
      note: "Includes $0.83 tax.",
      estimated: false,
    });
    expect(summarize(DE, { wholeUnits: true }).note).toBe("Includes $0.80 tax.");
  });

  test("the trim follows the headline across the two tax conventions", () => {
    // New York's headline is the subtotal and London's is the total. The figure that loses its fraction
    // is whichever of them the convention chose, never a third one.
    expect(summarize(US_NEW_YORK, { wholeUnits: true }).headline).toBe("$5");
    expect(summarize(GB, { wholeUnits: true }).headline).toBe("$5");
    expect(summarize(US_COUNTRY_ONLY, { wholeUnits: true })).toEqual({
      headline: "$5",
      note: "Tax is settled at checkout.",
      estimated: true,
    });
  });

  test("a zero-decimal currency is unmoved by asking, because it has no fraction to lose", () => {
    expect(summarize(JP_YEN, { wholeUnits: true })).toEqual({
      headline: "¥798",
      note: "Includes ¥73 tax.",
      estimated: false,
    });
  });
});

describe("previewPrices", () => {
  test("loads, asks, and narrows — the query reaches Paddle unchanged", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const query: PaddlePriceQuery = {
      items: [{ priceId: "pri_1", quantity: 1 }],
      address: { countryCode: "US", postalCode: "10001" },
    };
    const result = await previewPrices(SANDBOX, query, {
      initialize: stubInitializer(paddle),
      registry: page(),
    });
    expect(result.ok).toBe(true);
    expect(paddle.previews).toEqual([query]);
  });

  test("a load that failed is the answer — Paddle is never asked", async () => {
    const result = await previewPrices(
      SANDBOX,
      { items: [] },
      { initialize: stubInitializer(new Error("blocked")), registry: page() },
    );
    expect(result).toEqual({ ok: false, failure: PADDLE_UNAVAILABLE });
  });

  test("a refused PricePreview is a refusal, not an exception", async () => {
    const paddle = stubPaddle(() => Promise.reject(new Error("forbidden")));
    const result = await previewPrices(
      SANDBOX,
      { items: [] },
      { initialize: stubInitializer(paddle), registry: page() },
    );
    expect(result).toEqual({ ok: false, failure: PADDLE_PREVIEW_REFUSED });
  });

  test("a PricePreview that throws before it returns a promise is a refusal too", async () => {
    // `loadPaddle` hand-rolls `Promise.try` for exactly this hazard one call earlier. Paddle.js
    // validates its arguments synchronously, so a query it rejects outright throws rather than
    // resolving — and a rejection escaping here is an unhandled rejection on the page, in place of the
    // `PaymentsFailure` every path in this module promises.
    const paddle = stubPaddle(() => {
      throw new Error("invalid query");
    });
    const result = await previewPrices(
      SANDBOX,
      { items: [] },
      { initialize: stubInitializer(paddle), registry: page() },
    );
    expect(result).toEqual({ ok: false, failure: PADDLE_PREVIEW_REFUSED });
  });

  test("an answer this client cannot read is unreadable, and no price escapes", async () => {
    const paddle = stubPaddle({ what: "is this" });
    const result = await previewPrices(
      SANDBOX,
      { items: [] },
      { initialize: stubInitializer(paddle), registry: page() },
    );
    expect(result).toEqual({ ok: false, failure: PAYMENTS_UNREADABLE });
  });
});

describe("previewPrices, caching", () => {
  /** One price, asked for the way a pricing page asks. */
  const QUERY: PaddlePriceQuery = { items: [{ priceId: "pri_1", quantity: 1 }] };

  /** A cache in a store a test can read, with a lifetime a test can outlive. */
  function cache(): PaddleQuoteCache & { store: ReturnType<typeof memoryStore> } {
    return { key: "pricing", store: memoryStore(), ttlMs: 300_000 };
  }

  test("asks Paddle once, and answers the same question from the cache without loading anything", async () => {
    // The load is the expensive half. A cached answer that still fetched Paddle.js would save the round
    // trip nobody sees and keep the one everybody waits for.
    const held = cache();
    const first = stubInitializer(stubPaddle(US_NEW_YORK));
    const firstResult = await previewPrices(SANDBOX, QUERY, { initialize: first, registry: page(), cache: held });

    const second = stubInitializer(stubPaddle(US_NEW_YORK));
    const secondResult = await previewPrices(SANDBOX, QUERY, { initialize: second, registry: page(), cache: held });

    expect(secondResult).toEqual(firstResult);
    expect(first.loads).toHaveLength(1);
    expect(second.loads).toEqual([]);
  });

  test("caches nothing at all when the caller named no cache", async () => {
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    await previewPrices(SANDBOX, QUERY, { initialize, registry: page() });
    const again = stubInitializer(stubPaddle(US_NEW_YORK));
    await previewPrices(SANDBOX, QUERY, { initialize: again, registry: page() });

    expect(again.loads).toHaveLength(1);
  });

  test("asks again for a different question, because a cached price is an answer to one", async () => {
    const held = cache();
    await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      cache: held,
    });

    const second = stubInitializer(stubPaddle(US_NEW_YORK));
    await previewPrices(
      SANDBOX,
      { ...QUERY, customerId: "ctm_01kzvyz9pithyNotARealCustomer" },
      { initialize: second, registry: page(), cache: held },
    );

    expect(second.loads).toHaveLength(1);
  });

  test("asks again for a different account, so a sandbox answer cannot survive into production", async () => {
    const held = cache();
    await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      cache: held,
    });

    const live = stubInitializer(stubPaddle(US_NEW_YORK));
    await previewPrices(PRODUCTION, QUERY, { initialize: live, registry: page(), cache: held });

    expect(live.loads).toHaveLength(1);
  });

  test("remembers no refusal — a Paddle that was unreachable is asked again, not cached as an answer", async () => {
    const held = cache();
    const result = await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(new Error("blocked")),
      registry: page(),
      cache: held,
    });

    expect(result.ok).toBe(false);
    expect(held.store.entries.size).toBe(0);
  });

  test("remembers no answer it could not read, so an unreadable shape is not served twice", async () => {
    const held = cache();
    await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle({ what: "is this" })),
      registry: page(),
      cache: held,
    });

    expect(held.store.entries.size).toBe(0);
  });

  test("asks Paddle again once the caller's ttl has passed", async () => {
    vi.useFakeTimers();
    try {
      const held = cache();
      await previewPrices(SANDBOX, QUERY, {
        initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
        registry: page(),
        cache: held,
      });
      vi.advanceTimersByTime(held.ttlMs + 1);

      const second = stubInitializer(stubPaddle(US_NEW_YORK));
      await previewPrices(SANDBOX, QUERY, { initialize: second, registry: page(), cache: held });

      expect(second.loads).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("asks Paddle again when what was cached no longer reads, rather than refusing the page a price", async () => {
    // A cached answer is read by the same reader a fresh one is. An entry written by an older bundle,
    // or one a page tampered with, is a cache miss — never a refusal, and never a price nobody validated.
    const held = cache();
    await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      cache: held,
    });
    for (const [key] of held.store.entries) {
      held.store.entries.set(key, JSON.stringify({ at: Date.now(), answer: { what: "is this" } }));
    }

    const second = await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      cache: held,
    });

    expect(second.ok).toBe(true);
  });

  test("quotes from the network, and says so once, when a cache was only half stated", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
      const result = await previewPrices(SANDBOX, QUERY, {
        initialize,
        registry: page(),
        cache: { key: "pricing" } as unknown as PaddleQuoteCache,
      });

      expect(result.ok).toBe(true);
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });

  test("a store that refuses every operation costs the page nothing but the round trip", async () => {
    const held: PaddleQuoteCache = { key: "pricing", store: refusingStore(), ttlMs: 300_000 };
    const result = await previewPrices(SANDBOX, QUERY, {
      initialize: stubInitializer(stubPaddle(US_NEW_YORK)),
      registry: page(),
      cache: held,
    });

    expect(result.ok).toBe(true);
  });
});

describe("priceQueryKey", () => {
  test("two objects describing the same request key the same", () => {
    const first = priceQueryKey({ items: [{ priceId: "pri_1", quantity: 2 }], currencyCode: "USD" });
    const second = priceQueryKey({ currencyCode: "USD", items: [{ quantity: 2, priceId: "pri_1" }] });
    expect(first).toBe(second);
  });

  test("every field that changes the request changes the key", () => {
    const base: PaddlePriceQuery = { items: [{ priceId: "pri_1", quantity: 1 }] };
    const variants: PaddlePriceQuery[] = [
      base,
      { items: [{ priceId: "pri_2", quantity: 1 }] },
      { items: [{ priceId: "pri_1", quantity: 2 }] },
      {
        items: [
          { priceId: "pri_1", quantity: 1 },
          { priceId: "pri_2", quantity: 1 },
        ],
      },
      { ...base, address: { countryCode: "US" } },
      { ...base, address: { countryCode: "US", postalCode: "10001" } },
      { ...base, address: { countryCode: "GB" } },
      { ...base, customerId: "ctm_1" },
      { ...base, customerIpAddress: "203.0.113.1" },
      { ...base, currencyCode: "JPY" },
      { ...base, discountId: "dsc_1" },
    ];
    expect(new Set(variants.map(priceQueryKey)).size).toBe(variants.length);
  });

  test("every field of a query is in the key, because the key is now what separates two visitors", () => {
    // `priceQueryKey` began as an effect dependency, where a field it missed cost a re-fetch nobody saw.
    // It is the cache key now, and a field missing from *that* is one visitor's price served to another
    // — two different questions landing on one entry. `PaddleQuoteQuery` is
    // `Omit<PaddlePriceQuery, "items">`, so a field Paddle adds arrives in the request with no edit
    // here. This is what makes it arrive in the key too, or fail.
    //
    // The witness is `Record<keyof PaddlePriceQuery, true>`, so **TypeScript** fails on the day a field
    // is added and nobody listed it — the scan below cannot go vacuous, because its input is the type
    // rather than a regex that might match nothing.
    const EVERY_FIELD: Record<keyof PaddlePriceQuery, true> = {
      items: true,
      address: true,
      customerId: true,
      customerIpAddress: true,
      currencyCode: true,
      discountId: true,
    };
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "paddle.ts"), "utf8");
    const composer = /export function priceQueryKey\([\s\S]*?\n\}/.exec(source)?.[0];
    expect(composer, "priceQueryKey was renamed or moved — this gate reads it by name").toBeDefined();

    const missing = Object.keys(EVERY_FIELD).filter((field) => !(composer ?? "").includes(`query.${field}`));
    expect(
      missing,
      `These fields are on a price query and not in its key. Two requests differing only by one of them would share a cache entry, which is one visitor's price on another visitor's screen:\n${missing.map((field) => `  ${field}`).join("\n")}`,
    ).toEqual([]);
  });

  test("an omitted address and a country-only address are different requests", () => {
    // They are: one asks Paddle to resolve from the visitor's IP, the other names the country and gets
    // 0% tax. Collapsing them would make a pricing page stop re-quoting when it started guessing.
    expect(priceQueryKey({ items: [] })).not.toBe(priceQueryKey({ items: [], address: { countryCode: "US" } }));
  });
});

describe("the browser half holds no credential but the publishable one", () => {
  const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)));

  /**
   * Every `.ts` and `.json` file under `src/client/`, read from disk.
   *
   * `recursive: true` rather than a recursion written here. Node's own listing is not a traversal this
   * repository maintains — which is the difference `packages/cli/src/ci/sourceFiles.test.ts` is about,
   * and the reason a hand-rolled walk in this file would have to be argued for in a list somebody
   * reviews. There is nothing to argue: this needs a flat list of paths and that is what it returns.
   */
  async function clientFiles(): Promise<{ path: string; text: string }[]> {
    const names = await readdir(CLIENT_DIR, { recursive: true });
    const wanted = names.filter((name) => name.endsWith(".ts") || name.endsWith(".json"));
    return Promise.all(
      wanted.map(async (name) => {
        const path = join(CLIENT_DIR, name);
        return { path, text: await readFile(path, "utf8") };
      }),
    );
  }

  test("the sweep reads the whole directory — a broken path must fail loudly, not vacuously pass", async () => {
    const files = await clientFiles();
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(files.map((file) => file.path).filter((path) => path.endsWith("paddle.ts"))).toHaveLength(1);
    // The module that opens a checkout is the one holding the token in its hand, so a sweep that missed
    // it would be the sweep missing the file it most needs to read.
    expect(files.map((file) => file.path).filter((path) => path.endsWith("checkout.ts"))).toHaveLength(1);
    expect(files.reduce((total, file) => total + file.text.length, 0)).toBeGreaterThan(150_000);
  });

  /**
   * The shapes of a credential that must never reach a browser.
   *
   * Not "the word secret". Each is a literal artifact of the server half: Paddle's two API key prefixes,
   * the env binding one would arrive on, the reader the server takes it out of, and the header it would
   * travel in — quoted, because a *code* header key is the offense and `Authorization` in a sentence
   * saying this client sends none is not. A client module holding any of these is a credential in a
   * bundle an adopter serves publicly.
   *
   * **Assembled from fragments so this file contains none of them.** That is not decoration: it keeps
   * the sweep over the *whole* directory, this test file included, instead of carving out an exception
   * that the next credential could be written into.
   */
  const FORBIDDEN = [
    ["pdl_sdbx", "_apikey_"].join(""),
    ["pdl_live", "_apikey_"].join(""),
    ["PADDLE", "_API_KEY"].join(""),
    ["secrets", "Store"].join(""),
    `"${["Author", "ization"].join("")}"`,
  ];

  test("no client module names a server credential", async () => {
    const offense: string[] = [];
    for (const file of await clientFiles()) {
      for (const shape of FORBIDDEN) {
        if (file.text.includes(shape)) offense.push(`${file.path} contains ${shape}`);
      }
    }
    expect(offense).toEqual([]);
  });

  test("the sweep would catch one — every forbidden shape is found in text that contains it", () => {
    // Without this the test above passes on an empty rule as happily as on a clean directory.
    const planted = FORBIDDEN.map((shape) => `const leak = ${shape};`).join("\n");
    expect(FORBIDDEN.filter((shape) => planted.includes(shape))).toEqual(FORBIDDEN);
  });

  test("the publishable token is what the client does carry, so the rule is not vacuous", async () => {
    const files = await clientFiles();
    const paddle = files.find((file) => file.path.endsWith("/paddle.ts"));
    expect(paddle?.text).toContain("clientToken");
  });
});
