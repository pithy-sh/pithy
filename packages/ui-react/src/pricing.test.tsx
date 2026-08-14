// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { GB, US_COUNTRY_ONLY, US_NEW_YORK } from "@pithy-sh/payments/src/client/fixtures/pricePreview";
import type { PaddleInitializer, PaddleJs, PaddleRegistry, PaddleSetup } from "@pithy-sh/payments/src/client/paddle";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { type PricedProduct, PricingScreen } from "../templates/src/routes/pithy/pricing";

/**
 * The scaffolded pricing screen, rendered against real recorded Paddle answers.
 *
 * #343: `priceSummary` returns `{ headline, note, estimated }` and this screen rendered the first two.
 * A quote with no postal code resolved can be short of the tax the card is charged — United States tax
 * lives below the country, and Paddle answers a country-only request with 0% rather than an error — so a
 * dropped `estimated` renders an estimate exactly like a final price. That flag is the honesty property
 * the whole feature was built around, and whether it reaches the page is a fact about what is *rendered*.
 * No assertion about source text reaches it, so the file is mounted and read.
 *
 * The same is true of the anonymous visitor. This screen is public and its only action is `requireAuth()`
 * on the server, so a stranger who clicks Buy meets a wall. Which control they are offered instead is,
 * again, a rendered fact.
 *
 * **The fixtures are recordings, not compositions.** Each is a `PricePreview` fetched from the Paddle
 * sandbox; the estimated-ness of one comes from Paddle answering `postalCode: ""` to a country-only
 * request, not from anything this test asserts into it.
 */

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A sandbox setup. Shaped like Paddle's own publishable token, and obviously not a real one. */
const PADDLE: PaddleSetup = { clientToken: "test_pithyNotARealClientToken", environment: "sandbox" };

/** The price every recorded fixture quotes. A product whose id did not match would find no line at all. */
const PRICE_ID = "pri_01kzvyz9e21z9vbhd7xqq3csyh";

const PRO: PricedProduct = { id: "pro_monthly", name: "Pro", priceId: PRICE_ID };

/** A fetch that must never be called: nothing in a mounted pricing screen talks to the adopter's Worker. */
const noFetch = (() => {
  throw new Error("the pricing screen fetched a payments route on mount");
}) as unknown as typeof fetch;

/** A Paddle.js that answers `PricePreview` with one recorded response and opens nothing. */
function stubPaddle(answer: unknown): PaddleJs {
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview: () => Promise.resolve(answer),
    Checkout: { open: () => undefined, close: () => undefined },
  };
}

/** An initializer that hands back one Paddle. Nothing here reaches Paddle's CDN. */
function stubInitializer(paddle: PaddleJs): PaddleInitializer {
  return () => Promise.resolve(paddle);
}

/** A fresh page for one test, so no test can leave a loaded Paddle behind for the next. */
function paddlePage(): PaddleRegistry {
  return {};
}

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  // The quote resolves through Paddle's load and one promise hop after it. Without this the screen is
  // still in its loading state, which renders no price and would pass every negative assertion here.
  await act(async () => {
    await Promise.resolve();
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** Render the screen against one recorded quote, for one kind of visitor. */
async function screen(answer: unknown, signedIn: boolean | null = true): Promise<HTMLElement> {
  const container = await mount(
    <PricingScreen
      products={[PRO]}
      setup={PADDLE}
      signedIn={signedIn}
      client={{ fetch: noFetch }}
      paddle={{ initialize: stubInitializer(stubPaddle(answer)), registry: paddlePage() }}
    />,
  );
  // The loading branch renders "Getting your price." and no figure at all, so a test whose quote never
  // landed would report "no Estimated." and pass the negative case for the wrong reason.
  expect(container.textContent, "the quote never landed — the screen is still loading").not.toContain(
    "Getting your price.",
  );
  return container;
}

describe("the scaffolded pricing screen", () => {
  test("says an estimated quote is estimated", async () => {
    // The United States with no postal code. Paddle resolved the country, quoted 0% tax, and the buyer
    // will still be charged more at the card form — `postalCode: ""` in the recording is why.
    const container = await screen(US_COUNTRY_ONLY);
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent, "a quote that may be short of tax rendered as though it were final").toContain(
      "Estimated.",
    );
  });

  test("does not call a resolved quote estimated", async () => {
    // New York, 10001. The postal code resolved, the tax is the real 8.875%, and there is nothing left to
    // settle. Labelling this one too would make the label mean nothing.
    const container = await screen(US_NEW_YORK);
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("Plus $0.44 tax.");
    expect(container.textContent).not.toContain("Estimated.");
  });

  test("a quote with a postal code is not estimated, whatever the country's tax convention", async () => {
    // GB: VAT taken out of an inclusive figure rather than added on top, and a postal code resolved. The
    // label follows the postal code, not the convention and not the country.
    const container = await screen(GB);
    expect(container.textContent).toContain("Includes $0.83 tax.");
    expect(container.textContent).not.toContain("Estimated.");
  });

  test("an anonymous visitor is offered the way in, by name, instead of a button that fails", async () => {
    // The screen is public; `POST /payments/checkout` is `requireAuth()`. Before this the stranger got a
    // Buy button, a refusal, and a guard that redirected them away from what they were doing.
    const container = await screen(US_NEW_YORK, false);
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toContain("/sign-in");
    expect(links.find((link) => link.getAttribute("href") === "/sign-in")?.textContent).toBe("Sign in to buy Pro");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([]);
    // And the price is still there. Reading one has never needed an account.
    expect(container.textContent).toContain("$5.00");
  });

  test("a signed-in visitor gets the buy button, and no sign-in step", async () => {
    const container = await screen(US_NEW_YORK, true);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Buy Pro"]);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).not.toContain("/sign-in");
  });

  test("a visitor whose session is still being read is offered neither, yet", async () => {
    // Null is "we have not asked". Rendering the anonymous branch on it would flash a sign-in step at
    // every returning customer; rendering an enabled button would take the click that arrives first.
    const container = await screen(US_NEW_YORK, null);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Buy Pro"]);
    expect(buttons[0]?.disabled).toBe(true);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).not.toContain("/sign-in");
  });
});
