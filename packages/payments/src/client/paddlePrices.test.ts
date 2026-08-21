// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PAYMENTS_UNREADABLE } from "./api";
import { JP_YEN, US_COUNTRY_ONLY, US_NEW_YORK } from "./fixtures/pricePreview";
import type { PaddleInitializer, PaddleJs, PaddlePriceQuery, PaddleRegistry, PaddleSetup } from "./paddle";
import { type PaddleQuoteQuery, quotePlans } from "./paddlePrices";

/**
 * The quote core, against the recorded sandbox answers.
 *
 * Nothing here reaches Paddle's CDN: every test injects its own initializer and its own registry, the
 * way `paddle.test.ts` does and for the same two reasons — no network from a unit suite, and no loaded
 * Paddle left behind for the next test.
 */

/** A sandbox setup. Shaped like Paddle's own publishable token, and obviously not a real one. */
const SANDBOX: PaddleSetup = { clientToken: "test_pithyNotARealClientToken", environment: "sandbox" };

/** The price the recording quotes, and the product name it carries. */
const SOLO_PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";

/** A second line, cloned from the recording under a different price id. */
const TEAM_PRICE = "pri_01kzvyz9khsdy36z10wb8bgmq4";

/**
 * The Paddle customer a signed-in visitor is priced as. Shaped like a real `ctm_…`, and obviously not one.
 *
 * An identifier, not a credential. It names a customer and authorizes nothing, which is why Paddle reads
 * a price with it and a publishable client token — the pair it publishes for exactly this.
 */
const CUSTOMER = "ctm_01kzvyz9pithyNotARealCustomer";

/**
 * The recording, with a second line for {@link TEAM_PRICE}.
 *
 * Composed rather than recorded, deliberately and only here: the claim this feeds is "each plan takes
 * the line its own price id names", which is about matching and not about any figure Paddle chose. Every
 * number in both lines is still the recording's.
 */
function twoLines(): unknown {
  const envelope = structuredClone(US_NEW_YORK) as {
    data: { details: { lineItems: { price: { id: string }; product: { name: string } }[] } };
  };
  const [solo] = envelope.data.details.lineItems;
  if (solo === undefined) throw new Error("the recording has no line item");
  const team = structuredClone(solo);
  team.price.id = TEAM_PRICE;
  team.product.name = "Team";
  envelope.data.details.lineItems.push(team);
  return envelope;
}

/** A Paddle.js that answers `PricePreview` from the query it was handed, and records what it was asked. */
function stubAnswering(answer: (query: PaddlePriceQuery) => unknown): PaddleJs & { previews: PaddlePriceQuery[] } {
  const previews: PaddlePriceQuery[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview(query: PaddlePriceQuery) {
      previews.push(query);
      return Promise.resolve(answer(query));
    },
    Checkout: {
      open: () => {
        throw new Error("no test in prices.test.ts opens a checkout");
      },
      close: () => undefined,
    },
    previews,
  };
}

/** A Paddle.js that answers `PricePreview` with one fixed value, whatever it was asked. */
function stubPaddle(answer: unknown): PaddleJs & { previews: PaddlePriceQuery[] } {
  return stubAnswering(() => answer);
}

/**
 * A Paddle.js that resolves location the way Paddle does.
 *
 * A query naming a customer is answered from the address Paddle holds for them — New York, postal code
 * resolved, 8.875% added on top. A query naming nobody is answered from the browser's IP, which resolves
 * the country and no postal code, so tax comes back 0% while the card is still charged $5.44. That
 * contrast is the whole of what a location parameter is for, and a stub answering the same either way
 * could not tell a quote that resolved one from a quote that resolved the other.
 */
function stubResolvingLocation(): PaddleJs & { previews: PaddlePriceQuery[] } {
  return stubAnswering((query) => (query.customerId === undefined ? US_COUNTRY_ONLY : US_NEW_YORK));
}

/** An initializer that answers with a fixed Paddle and records the token it was asked for. */
function stubInitializer(paddle: PaddleJs | undefined): PaddleInitializer & { loads: string[] } {
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

describe("quotePlans", () => {
  test("quotes each plan from the line its own price id names", async () => {
    const paddle = stubPaddle(twoLines());
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE, team: TEAM_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(result).toEqual({
      ok: true,
      value: [
        {
          plan: "solo",
          priceId: SOLO_PRICE,
          headline: "$5.00",
          note: "Plus $0.44 tax.",
          estimated: false,
          currency: "USD",
        },
        {
          plan: "team",
          priceId: TEAM_PRICE,
          headline: "$5.00",
          note: "Plus $0.44 tax.",
          estimated: false,
          currency: "USD",
        },
      ],
    });
  });

  test("asks Paddle for one of each plan's price, and nothing else", async () => {
    const paddle = stubPaddle(twoLines());
    await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE, team: TEAM_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(paddle.previews).toEqual([
      {
        items: [
          { priceId: SOLO_PRICE, quantity: 1 },
          { priceId: TEAM_PRICE, quantity: 1 },
        ],
      },
    ]);
  });

  test("asks for one price once, however many plans name it", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE, "solo-featured": SOLO_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(paddle.previews).toEqual([{ items: [{ priceId: SOLO_PRICE, quantity: 1 }] }]);
    expect(result.ok && result.value.map((quote) => quote.plan)).toEqual(["solo", "solo-featured"]);
  });

  test("leaves out a plan Paddle quoted no line for, rather than quoting it wrong", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE, team: TEAM_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(result.ok && result.value.map((quote) => quote.plan)).toEqual(["solo"]);
  });

  test("loads nothing at all when no plan was named", async () => {
    const initialize = stubInitializer(stubPaddle(US_NEW_YORK));
    const result = await quotePlans(SANDBOX, {}, { initialize, registry: page() });

    expect(result).toEqual({ ok: true, value: [] });
    expect(initialize.loads).toEqual([]);
  });

  test("hands back the refusal when Paddle's answer cannot be read", async () => {
    const paddle = stubPaddle({ data: { currencyCode: "USD" } });
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(result).toEqual({ ok: false, failure: PAYMENTS_UNREADABLE });
  });

  test("carries the customer it was given, and nothing the caller did not give", async () => {
    // Byte for byte the query the dashboard's own gate asserts. A quote must resolve from the same
    // Paddle row the charge will, and `customerId` is how it reaches the one address on file.
    const paddle = stubPaddle(US_NEW_YORK);
    await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { query: { customerId: CUSTOMER }, initialize: stubInitializer(paddle), registry: page() },
    );

    expect(paddle.previews).toEqual([{ items: [{ priceId: SOLO_PRICE, quantity: 1 }], customerId: CUSTOMER }]);
  });

  test("carries the rest of a query too — an address, an IP, a currency, a discount", async () => {
    const paddle = stubPaddle(US_NEW_YORK);
    await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      {
        query: {
          address: { countryCode: "US", postalCode: "10001" },
          customerIpAddress: "203.0.113.7",
          currencyCode: "USD",
          discountId: "dsc_01kzvyz9pithyNotARealDiscount",
        },
        initialize: stubInitializer(paddle),
        registry: page(),
      },
    );

    expect(paddle.previews).toEqual([
      {
        items: [{ priceId: SOLO_PRICE, quantity: 1 }],
        address: { countryCode: "US", postalCode: "10001" },
        customerIpAddress: "203.0.113.7",
        currencyCode: "USD",
        discountId: "dsc_01kzvyz9pithyNotARealDiscount",
      },
    ]);
  });

  test("quotes the plans it was given, whatever else a query claims", async () => {
    // TypeScript forbids `items` in the caller's half of the query, and a program compiled from
    // JavaScript is not asking TypeScript. The plans are the one part of the query this function owns.
    const paddle = stubPaddle(US_NEW_YORK);
    const query = { items: [{ priceId: "pri_01kzvyz9notthepricethatwasnamed", quantity: 9 }] } as PaddleQuoteQuery;
    await quotePlans(SANDBOX, { solo: SOLO_PRICE }, { query, initialize: stubInitializer(paddle), registry: page() });

    expect(paddle.previews).toEqual([{ items: [{ priceId: SOLO_PRICE, quantity: 1 }] }]);
  });

  test("quotes a customer from the address Paddle holds, and does not call that an estimate", async () => {
    const paddle = stubResolvingLocation();
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { query: { customerId: CUSTOMER }, initialize: stubInitializer(paddle), registry: page() },
    );

    expect(result.ok && result.value).toEqual([
      {
        plan: "solo",
        priceId: SOLO_PRICE,
        headline: "$5.00",
        note: "Plus $0.44 tax.",
        estimated: false,
        currency: "USD",
      },
    ]);
  });

  test("still quotes from the network, and says the figure is an estimate, when nobody said where", async () => {
    const paddle = stubResolvingLocation();
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { initialize: stubInitializer(paddle), registry: page() },
    );

    expect(result.ok && result.value.map((quote) => quote.estimated)).toEqual([true]);
  });

  test("quotes what Paddle rendered, unless the caller asked for whole units", async () => {
    // The gate the option exists under, at the surface the dashboard calls. Not asking, and asking for
    // `false`, must both be the string Paddle sent — a default that trimmed would restyle a seller's
    // prices on their behalf, and this is where that would show.
    const untouched = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { initialize: stubInitializer(stubPaddle(US_NEW_YORK)), registry: page() },
    );
    const declined = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { wholeUnits: false, initialize: stubInitializer(stubPaddle(US_NEW_YORK)), registry: page() },
    );

    expect(untouched.ok && untouched.value.map((quote) => quote.headline)).toEqual(["$5.00"]);
    expect(declined.ok && declined.value.map((quote) => quote.headline)).toEqual(["$5.00"]);
  });

  test("drops a zero fraction from every plan when the caller asked for whole units", async () => {
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE, team: TEAM_PRICE },
      { wholeUnits: true, initialize: stubInitializer(stubPaddle(twoLines())), registry: page() },
    );

    expect(result.ok && result.value.map((quote) => quote.headline)).toEqual(["$5", "$5"]);
    // The sentence beside it is unchanged, which is the half a caller must be able to rely on.
    expect(result.ok && result.value.map((quote) => quote.note)).toEqual(["Plus $0.44 tax.", "Plus $0.44 tax."]);
  });

  test("asking for whole units changes nothing in a currency that has no fraction", async () => {
    const result = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { wholeUnits: true, initialize: stubInitializer(stubPaddle(JP_YEN)), registry: page() },
    );

    expect(result.ok && result.value.map((quote) => quote.headline)).toEqual(["¥798"]);
  });

  test("carries the currency Paddle answered in, which is not always the one it answered last time", async () => {
    // `PaddlePlanQuote` was the only thing holding `preview.currencyCode`, and it dropped it — so a
    // caller formatting the figure itself had nothing to format it in.
    const yen = stubPaddle(JP_YEN);
    const dollars = stubPaddle(US_NEW_YORK);

    const inYen = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { initialize: stubInitializer(yen), registry: page() },
    );
    const inDollars = await quotePlans(
      SANDBOX,
      { solo: SOLO_PRICE },
      { initialize: stubInitializer(dollars), registry: page() },
    );

    expect(inYen.ok && inYen.value.map((quote) => quote.currency)).toEqual(["JPY"]);
    expect(inDollars.ok && inDollars.value.map((quote) => quote.currency)).toEqual(["USD"]);
  });
});
