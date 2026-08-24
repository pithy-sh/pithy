// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createTranslator, type Translator } from "@pithy-sh/core/src/i18n/translator";
// The kit's translations, read as the value `@pithy-sh/i18n` composes into its layers rather than as
// files on disk — the same import `signIn.test.tsx` makes, for the same reason.
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import { GB, US_COUNTRY_ONLY, US_NEW_YORK } from "@pithy-sh/payments/src/client/fixtures/pricePreview";
import type {
  PaddleInitializer,
  PaddleJs,
  PaddlePriceQuery,
  PaddleRegistry,
  PaddleSetup,
} from "@pithy-sh/payments/src/client/paddle";
import type { PriceVisitor } from "@pithy-sh/payments/src/pricing/location";
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

/** A Paddle customer, shaped as Paddle's own ids are. The same value `POST /payments/checkout` charges. */
const PADDLE_CUSTOMER = "ctm_01hv8wptq8987qeep44cyrewp9";

/** London, SW1A 1AA — the address the {@link GB} recording was fetched from. */
const LONDON: PriceVisitor = { address: { countryCode: "GB", postalCode: "SW1A 1AA" } };

/** New York, 10001 — the address the {@link US_NEW_YORK} recording was fetched from. */
const NEW_YORK: PriceVisitor = { address: { countryCode: "US", postalCode: "10001" } };

/** A fetch that must never be called: nothing in a mounted pricing screen talks to the adopter's Worker. */
const noFetch = (() => {
  throw new Error("the pricing screen fetched a payments route on mount");
}) as unknown as typeof fetch;

/** Every query this page put to Paddle, in order. What the screen *asked* is half of what it renders. */
let asked: PaddlePriceQuery[] = [];

/** A Paddle.js that answers `PricePreview` with one recorded response, recording what it was asked. */
function stubPaddle(answer: unknown): PaddleJs {
  return {
    Initialized: true,
    Environment: { set: () => undefined },
    PricePreview: (query: PaddlePriceQuery) => {
      asked.push(query);
      return Promise.resolve(answer);
    },
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
  asked = [];
});

/**
 * Where "sign in to buy" is told to point.
 *
 * Deliberately not `/sign-in`: the screen takes the path rather than writing one, so the assertion has
 * to be a value only this file could have supplied. A real path here would pass against a screen that
 * went back to a literal (#393).
 */
const SIGN_IN = "/gate-canary-not-the-sign-in-path";

/** And where "what do I already have?" is told to point. Same rule, same reason. */
const SUBSCRIPTION = "/gate-canary-not-the-subscription-path";

/** Render the screen against one recorded quote, for one kind of visitor. */
async function screen(
  answer: unknown,
  signedIn: boolean | null = true,
  visitor: PriceVisitor | null = null,
  t?: Translator,
): Promise<HTMLElement> {
  const container = await mount(
    <PricingScreen
      products={[PRO]}
      setup={PADDLE}
      signedIn={signedIn}
      signInPath={SIGN_IN}
      subscriptionPath={SUBSCRIPTION}
      visitor={visitor}
      client={{ fetch: noFetch }}
      paddle={{ initialize: stubInitializer(stubPaddle(answer)), registry: paddlePage() }}
      {...(t ? { t } : {})}
    />,
  );
  // The loading branch renders "Getting your price." and no figure at all, so a test whose quote never
  // landed would report "no Estimated." and pass the negative case for the wrong reason.
  //
  // Looked up through the translator in play rather than written down once, because a screen rendering
  // Spanish never says the English sentence and this guard would then be watching for a string that
  // could not appear — a floor that holds for one language only is no floor.
  expect(container.textContent, "the quote never landed — the screen is still loading").not.toContain(
    t ? t.t("payments/pricing.loading") : "Getting your price.",
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
    // New York, 10001 — the address the recording was fetched from, so the screen is handed it too. The
    // postal code resolved, the tax is the real 8.875%, and there is nothing left to settle. Labeling
    // this one too would make the label mean nothing.
    const container = await screen(US_NEW_YORK, true, NEW_YORK);
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("Plus $0.44 tax.");
    expect(container.textContent).not.toContain("Estimated.");
  });

  test("a quote from a known address with a postal code is not estimated, whatever the tax convention", async () => {
    // GB: VAT taken out of an inclusive figure rather than added on top, and a postal code resolved. The
    // label follows the address and the postal code, not the convention and not the country.
    const container = await screen(GB, true, LONDON);
    expect(container.textContent).toContain("Includes $0.83 tax.");
    expect(container.textContent).not.toContain("Estimated.");
  });

  test("a signed-in customer is quoted from the customer Paddle holds, not from their IP", async () => {
    // #340. `PaddlePriceQuery` has taken `customerId` since the rail landed and nothing routed a
    // signed-in visitor to it, so the screen read an IP-derived guess while the authoritative answer —
    // the billing address the card is charged from — sat on file at Paddle.
    await screen(US_NEW_YORK, true, { customerId: PADDLE_CUSTOMER });
    expect(asked.map((query) => query.customerId)).toEqual([PADDLE_CUSTOMER]);
  });

  test("an IP-derived figure is labeled an estimate even when the answer carries a postal code", async () => {
    // #340. The label is a fact about *where the location came from*, not about which fields Paddle
    // filled in. An IP is a guess at where somebody lives; the charge settles on the billing address they
    // have not given yet. Deriving the label from `postalCode` alone made it right by accident — Paddle
    // resolves no postal code from an IP today — and an accident is not a rule.
    const container = await screen(GB, false);
    expect(asked.map((query) => query.customerId)).toEqual([undefined]);
    expect(container.textContent, "an IP-derived figure rendered as though it were the charge").toContain("Estimated.");
  });

  test("an anonymous visitor's query names neither a customer nor an address", async () => {
    // The anonymous path is the one that must not change: Paddle resolves the country from the browser's
    // own IP, which is the best answer available for somebody nobody has met.
    await screen(US_NEW_YORK, false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.customerId).toBeUndefined();
    expect(asked[0]?.address).toBeUndefined();
    expect(asked[0]?.items).toEqual([{ priceId: PRICE_ID, quantity: 1 }]);
  });

  test("a known billing address is asked about by address when there is no Paddle customer yet", async () => {
    // The middle state: signed in, an address the app holds, no purchase ever made so no `ctm_…` exists.
    // Quoting from the address still beats quoting from the browser's location.
    await screen(GB, true, LONDON);
    expect(asked[0]?.address).toEqual({ countryCode: "GB", postalCode: "SW1A 1AA" });
    expect(asked[0]?.customerId).toBeUndefined();
  });

  test("an anonymous visitor is offered the way in, by name, instead of a button that fails", async () => {
    // The screen is public; `POST /payments/checkout` is `requireAuth()`. Before this the stranger got a
    // Buy button, a refusal, and a guard that redirected them away from what they were doing.
    const container = await screen(US_NEW_YORK, false);
    const links = [...container.querySelectorAll("a")];
    expect(SIGN_IN).not.toBe("/sign-in");
    expect(links.map((link) => link.getAttribute("href"))).toContain(SIGN_IN);
    expect(links.find((link) => link.getAttribute("href") === SIGN_IN)?.textContent).toBe("Sign in to buy Pro");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([]);
    // And the price is still there. Reading one has never needed an account.
    expect(container.textContent).toContain("$5.00");
  });

  test("a payments-only project draws no link to a sign-in screen it does not have", async () => {
    // `useOptionalScreenPath` answers null there. A literal would have pointed a stranger at a route
    // nothing serves; throwing would have taken the whole pricing page down (#393).
    const container = await mount(
      <PricingScreen
        products={[PRO]}
        setup={PADDLE}
        signedIn={false}
        signInPath={null}
        subscriptionPath={SUBSCRIPTION}
        visitor={null}
        client={{ fetch: noFetch }}
        paddle={{ initialize: stubInitializer(stubPaddle(US_NEW_YORK)), registry: paddlePage() }}
      />,
    );
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).not.toContain("Sign in to buy Pro");
    // And the price is still on the page: reading one has never needed an account, or an auth capability.
    expect(container.textContent).toContain("$5.00");
  });

  test("a signed-in visitor gets the buy button, and no sign-in step", async () => {
    const container = await screen(US_NEW_YORK, true);
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Buy Pro"]);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).not.toContain(SIGN_IN);
  });

  test("a visitor whose session is still being read is offered neither, yet", async () => {
    // Null is "we have not asked". Rendering the anonymous branch on it would flash a sign-in step at
    // every returning customer; rendering an enabled button would take the click that arrives first.
    const container = await screen(US_NEW_YORK, null);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Buy Pro"]);
    expect(buttons[0]?.disabled).toBe(true);
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).not.toContain(SIGN_IN);
  });
});

/**
 * The same screen, in a second language — and in none.
 *
 * The argument is `subscription.test.tsx`'s, and this screen adds the half that one has not got: a
 * **count**. `every()` used to be `frequency === 1 ? \`a ${interval}\` : \`every ${frequency} ${interval}s\``,
 * which is not a plural form in any language but English — Spanish has two, Russian three, and a
 * comparison against `1` has none. It goes through `t.plural` now, and that is a rendered fact.
 *
 * **No figure is asserted in Spanish, and none may be.** Every price on this screen comes from Paddle
 * for this visitor; what is under test here is the sentences around it.
 */
describe("the pricing screen's language", () => {
  /** Spanish, over the kit's catalog alone — no English layer, so an untranslated key renders the key. */
  const es: Translator = createTranslator({ catalogLocale: "es", layers: [KIT_CATALOGS.es] });

  test("renders the words of the language it was handed", async () => {
    const container = await screen(GB, true, LONDON, es);
    const text = container.textContent ?? "";
    for (const key of ["payments/pricing.title", "payments/pricing.body", "payments/pricing.holdings"]) {
      const sentence = KIT_CATALOGS.es?.[key];
      expect(sentence, `the kit ships no Spanish for ${key}`).toBeTypeOf("string");
      expect(text, key).toContain(sentence);
    }
    // The anti-vacuity half: a screen that ignored its `t` prop passes every `toContain` above and fails
    // this one.
    expect(text).not.toContain("What it costs.");
  });

  test("says how often a price bills through the plural of the locale, not a comparison against one", async () => {
    // The recorded quote bills monthly — `{ interval: "month", frequency: 1 }` — so the Spanish reads the
    // `.one` form. `month` stays English because it is Paddle's word, arriving from their API rather than
    // from a catalog, which is stated in the screen's own docblock and is what an adopter overrides in
    // `messages` if it matters to them.
    const container = await screen(GB, true, LONDON, es);
    expect(container.textContent, "the billing period is not rendered through the catalog at all").toContain(
      "al month",
    );
    // And the English form is gone from the page, which is what fails if `every()` goes back to a literal.
    expect(container.textContent).not.toContain("a month");
  });

  test("with no translator at all, renders the English it was scaffolded with", async () => {
    // The direction the whole capability's optionality rests on: `useTranslator` with no provider is a
    // translator over the screen's own baked catalog, so a project that never composed `i18n` reads
    // exactly as it did before any of this existed.
    const text = (await screen(GB, true, LONDON)).textContent ?? "";
    expect(text).toContain("What it costs.");
    expect(text).toContain("Prices are for where you are. Tax is Paddle's to calculate, not ours.");
    expect(text).toContain("What do I already have?");
    expect(text).toContain("a month");
    expect(text).not.toContain(KIT_CATALOGS.es?.["payments/pricing.title"] ?? "«no es catalog»");
  });
});
