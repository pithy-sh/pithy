// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { initializePaddle, Paddle } from "@paddle/paddle-js";
import { describe, expect, expectTypeOf, test } from "vitest";
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
  previewPrices,
  priceQueryKey,
  priceSummary,
  readPricePreview,
} from "./paddle";

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

  test("the United Kingdom takes VAT out of an inclusive price — the opposite convention, same catalogue", () => {
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

  test("currency is not localized without a catalogue override — the UK and Germany are quoted in dollars", () => {
    // The measurement that stops "localized pricing" from being a claim this rail cannot keep. Currency
    // comes from `unit_price_overrides`, which is catalogue data. What localizes without one is tax.
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

  test("a converted quote cannot be told against a catalogue amount in another currency", () => {
    // The catalogue lists USD 500. This quote is in yen. Neither 725 nor 798 is "the listed price", so
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
      details: { lineItems: { formattedTotals?: unknown }[] };
    };
    const first = damaged.details.lineItems[0];
    if (!first) throw new Error("unreachable");
    first.formattedTotals = undefined;
    expect(readPricePreview(damaged)).toBeNull();
  });

  test("an amount that arrives as a number is refused, not coerced", () => {
    // Paddle sends every amount as a string. A number here means the shape changed, and rendering
    // `String(544)` as a price would be the wrong kind of resilience.
    const damaged = structuredClone(US_NEW_YORK) as {
      details: { lineItems: { formattedUnitTotals: { total: unknown } }[] };
    };
    const first = damaged.details.lineItems[0];
    if (!first) throw new Error("unreachable");
    first.formattedUnitTotals.total = 544;
    expect(readPricePreview(damaged)).toBeNull();
  });

  test("an empty catalogue answer is a preview with no lines, not a refusal", () => {
    const empty = readPricePreview({ currencyCode: "USD", details: { lineItems: [] } });
    expect(empty).toEqual({ currencyCode: "USD", countryCode: null, postalCode: null, lines: [] });
  });
});

describe("priceSummary", () => {
  /** The summary for a fixture's only line. */
  function summarize(fixture: unknown) {
    const preview = readPricePreview(fixture);
    if (preview === null) throw new Error("unreachable");
    const only = preview.lines[0];
    if (!only) throw new Error("unreachable");
    return priceSummary(preview, only);
  }

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

  test("the two conventions put different numbers in the headline from one catalogue price", () => {
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
    for (const fixture of [US_NEW_YORK, GB, DE, JP_YEN, US_COUNTRY_ONLY]) {
      expect(JSON.stringify(fixture)).toContain(`"${summarize(fixture).headline}"`);
    }
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

  test("an omitted address and a country-only address are different requests", () => {
    // They are: one asks Paddle to resolve from the visitor's IP, the other names the country and gets
    // 0% tax. Collapsing them would make a pricing page stop re-quoting when it started guessing.
    expect(priceQueryKey({ items: [] })).not.toBe(priceQueryKey({ items: [], address: { countryCode: "US" } }));
  });
});

describe("the browser half holds no credential but the publishable one", () => {
  const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)));

  /** Every `.ts` and `.json` file under `src/client/`, read from disk. */
  async function clientFiles(dir: string = CLIENT_DIR): Promise<{ path: string; text: string }[]> {
    const found: { path: string; text: string }[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await clientFiles(path)));
      else if (path.endsWith(".ts") || path.endsWith(".json")) {
        found.push({ path, text: await readFile(path, "utf8") });
      }
    }
    return found;
  }

  test("the sweep reads the whole directory — a broken path must fail loudly, not vacuously pass", async () => {
    const files = await clientFiles();
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.map((file) => file.path).filter((path) => path.endsWith("paddle.ts"))).toHaveLength(1);
    expect(files.reduce((total, file) => total + file.text.length, 0)).toBeGreaterThan(80_000);
  });

  /**
   * The shapes of a credential that must never reach a browser.
   *
   * Not "the word secret". Each is a literal artefact of the server half: Paddle's two API key prefixes,
   * the env binding one would arrive on, the reader the server takes it out of, and the header it would
   * travel in — quoted, because a *code* header key is the offence and `Authorization` in a sentence
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
    const offences: string[] = [];
    for (const file of await clientFiles()) {
      for (const shape of FORBIDDEN) {
        if (file.text.includes(shape)) offences.push(`${file.path} contains ${shape}`);
      }
    }
    expect(offences).toEqual([]);
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
