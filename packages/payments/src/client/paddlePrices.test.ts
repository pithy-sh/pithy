// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PAYMENTS_UNREADABLE } from "./api";
import { US_NEW_YORK } from "./fixtures/pricePreview";
import type { PaddleInitializer, PaddleJs, PaddlePriceQuery, PaddleRegistry, PaddleSetup } from "./paddle";
import { quotePlans } from "./paddlePrices";

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

/** A Paddle.js that answers `PricePreview` with a fixed value and records what it was asked. */
function stubPaddle(answer: unknown): PaddleJs & { previews: PaddlePriceQuery[] } {
  const previews: PaddlePriceQuery[] = [];
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview(query: PaddlePriceQuery) {
      previews.push(query);
      return Promise.resolve(answer);
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
        { plan: "solo", priceId: SOLO_PRICE, headline: "$5.00", note: "Plus $0.44 tax.", estimated: false },
        { plan: "team", priceId: TEAM_PRICE, headline: "$5.00", note: "Plus $0.44 tax.", estimated: false },
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
});
