import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import type { PaymentsClientOptions } from "@pithy-sh/payments/src/client/api";
import { useCheckout, usePaddleCheckout, usePricePreview } from "@pithy-sh/payments/src/client/hooks";
import { type PaddleOptions, type PaddleSetup, priceSummary } from "@pithy-sh/payments/src/client/paddle";
import {
  type PriceVisitor,
  priceQueryFor,
  quoteIsEstimated,
  resolvePriceLocation,
} from "@pithy-sh/payments/src/pricing/location";
import type { ReactNode } from "react";
// `CHECKOUT_FRAME` is imported rather than declared here: the two screens that sell share one class, and
// `.pithy-checkout` is a hook you are meant to style. Two copies is one styled checkout and one bare one.
import { CHECKOUT_FRAME, failureText, paddleSetup, paymentsClient, usePriceVisitor } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link, useOptionalScreenPath, useScreenPath, useSignedIn } from "../../router";
import "../../pithy-screens.css";

export const path = "/pricing";

// No session. A pricing page is the one screen a stranger has to be able to read, and asking Paddle what
// this visitor pays needs nothing but the publishable token.
//
// Buying is the other half, and it does need an account — the server's checkout route is `requireAuth()`.
// So this screen draws the visitor it has: a stranger is offered the way in, by name, before the click.
// Leaving that to the guard would sell someone a price and then meet them with a wall.

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// It renders and styles. Every figure on it comes from Paddle, for this visitor — there is no price
// string in this file, and there must never be one. A hardcoded number is wrong in every country whose
// tax convention differs from the one it was written in, and it is wrong silently.

/** The products this project sells through Paddle, with the price id each is sold at. */
const PADDLE_PRODUCTS =
  paymentsConfig.enabled && paymentsConfig.rails.paddle
    ? paymentsConfig.products.flatMap((product) =>
        product.skus.paddle === null ? [] : [{ ...product, priceId: product.skus.paddle }],
      )
    : [];

/**
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * **No figure is in here, and none ever may be.** Every price this screen renders comes from Paddle,
 * for this visitor, in their own currency and under their own tax convention; a number written into a
 * message would be wrong in every country whose convention differs from the one it was typed in, and
 * wrong silently. `templates.test.ts` sweeps this file for one.
 *
 * `{interval}` is Paddle's word for the billing period — `month`, `year` — and arrives from their API
 * rather than from a catalog, so a translated `every` message still names the period in English. Say
 * the period yourself in `messages` if that matters to you; the kit will not invent a vocabulary for
 * somebody else's API.
 */
const EN = {
  "payments/pricing.title": "What it costs.",
  "payments/pricing.body": "Prices are for where you are. Tax is Paddle's to calculate, not ours.",
  "payments/pricing.anonymous": "Anyone can read a price. Buying needs an account.",
  "payments/pricing.loading": "Getting your price.",
  "payments/pricing.estimated": "Estimated.",
  "payments/pricing.unavailable": "We couldn't get a price. You'll see it at checkout.",
  "payments/pricing.sign_in": "Sign in to buy {product}",
  "payments/pricing.buy": "Buy {product}",
  "payments/pricing.holdings": "What do I already have?",
  "payments/pricing.every.one": "a {interval}",
  "payments/pricing.every.other": "every {count} {interval}s",
  "payments/pricing.empty.title": "Nothing priced here.",
  "payments/pricing.empty.body": "This screen prices what you sell through Paddle. Add a",
  "payments/pricing.empty.body_end": "block to a product in",
} satisfies MessageCatalog;

/**
 * How often a price bills, in words. Null for a one-off, which needs no suffix.
 *
 * Through `plural` rather than a comparison against `1`, because the frequency is a count and a count
 * is what a second locale asks a different question about: English has two forms here, Russian three,
 * and `frequency === 1 ? … : …` has none of them.
 */
function every(t: Translator, cycle: { interval: string; frequency: number } | null): string | null {
  if (cycle === null) return null;
  return t.plural("payments/pricing.every", cycle.frequency, { interval: cycle.interval });
}

/** One product, as this screen needs it: what to call it, and which price to quote. */
export interface PricedProduct {
  /** The catalogue id, which `start` buys by. */
  readonly id: string;
  /** The product's name, as the catalogue has it. */
  readonly name: string;
  /** The Paddle price it is sold at — `pri_…`. */
  readonly priceId: string;
}

export interface PricingScreenProps {
  /**
   * The translator this screen renders through.
   *
   * A prop for the reason `visitor` and `paddle` are: what a screen says in a second language is a
   * *rendered* fact no assertion about source text can reach. Absent, the screen reads the provider a
   * `TranslatorProvider` mounted, and with no provider it reads {@link EN}.
   */
  readonly t?: Translator;
  /** What this project sells through Paddle. Empty is a real state, and it has its own screen. */
  readonly products: readonly PricedProduct[];
  /** What Paddle.js starts with, or null when the rail is off. */
  readonly setup: PaddleSetup | null;
  /**
   * Whether there is a session — null while that is still being read.
   *
   * A prop rather than a hook call inside, for the reason `SubscriptionScreen` takes its rails: which
   * control a visitor is offered is a *rendered* fact, and the anonymous one is the case nobody sees
   * while developing signed in.
   */
  readonly signedIn: boolean | null;
  /**
   * Where "sign in to buy" points — the path the sign-in screen declares, read through the role it
   * claims. A prop for the same reason the rest of this screen's world is: nothing here reads a
   * config a Vite build has to produce. Never a literal `/sign-in`, which survives a rename and lands
   * a stranger on the not-found screen (#393).
   *
   * `null` in a payments-only project, where there is no sign-in screen. Nothing sends an anonymous
   * visitor anywhere then — `useSignedIn` answers "signed in" with no auth composed — so the branch
   * this feeds is unreachable there, and a link is not drawn to a screen that does not exist.
   */
  readonly signInPath: string | null;
  /** Where "what do I already have?" points — the subscription screen's declared path, same rule. */
  readonly subscriptionPath: string;
  /**
   * What is known about where this visitor is charged from, or null when nothing is.
   *
   * Null is a real answer and the common one: a stranger reading a marketing page has no billing address
   * anywhere, and Paddle resolving the country from their IP is the best available. What null must never
   * be is a *silent* answer — `resolvePriceLocation` turns it into a location that says it is provisional,
   * and the figure is labelled from that.
   */
  readonly visitor: PriceVisitor | null;
  /** Where the payments routes are, and the fetch to reach them with. Injected so a test never navigates. */
  readonly client?: PaymentsClientOptions;
  /** How Paddle.js is loaded. Injected so a test never reaches Paddle's CDN. */
  readonly paddle?: PaddleOptions;
}

/**
 * The pricing screen, taking its catalogue and its visitor rather than reading them.
 *
 * Two things here are only true of what is *rendered*, which is why this is a component with props and
 * not a file that reads its config: an estimated quote has to look estimated, and an anonymous visitor
 * has to be offered a way in rather than a button that fails.
 */
export function PricingScreen({
  products,
  setup,
  signedIn,
  signInPath,
  subscriptionPath,
  visitor,
  client,
  paddle,
  t: given,
}: PricingScreenProps): ReactNode {
  // Called unconditionally, and chosen from afterwards: `given ?? useTranslator(EN)` would skip the hook
  // whenever the prop is passed, which is a hook count that changes between renders.
  const baked = useTranslator(EN);
  const t = given ?? baked;
  /**
   * One quote per product, asked for in one round trip.
   *
   * Rebuilt every render, which costs nothing: the hook depends on `priceQueryKey`, so what re-quotes is
   * the request changing and never the array's identity.
   */
  const items = products.map((product) => ({ priceId: product.priceId, quantity: 1 }));
  /**
   * Where this visitor is priced from, chosen explicitly rather than defaulted into.
   *
   * The whole of the choice lives in the package — a screen scaffolded into an adopter's repo a year ago
   * must not be the thing that decides which of three answers is authoritative. What this file does is
   * hand over what it knows and render what comes back.
   */
  const location = resolvePriceLocation(visitor);
  // Null when there is nothing to quote. A preview for zero items is a request Paddle refuses, and
  // refusing it here costs a round trip and an error message on a screen whose honest state is empty.
  //
  // The query re-issues when the location does. A signed-in customer's `ctm_…` arrives one round trip
  // after the page paints, so the first figure is the IP estimate and the second is the charge — a price
  // that changes once the address is known, which is what every checkout on the web does and what the
  // "Estimated." label is there to have promised in advance.
  const quoted = usePricePreview(items.length > 0 ? setup : null, priceQueryFor(items, location), paddle);
  const checkout = useCheckout(client);
  // The checkout opens over this page or inside it — it never navigates away, which is the whole reason
  // this rail has a pricing screen with a buy button on it rather than a link to somebody else's page.
  const opened = usePaddleCheckout(checkout.handoff, { ...paddle, frameTarget: CHECKOUT_FRAME });

  if (products.length === 0) {
    return (
      <main className="screen">
        <h1>{t.t("payments/pricing.empty.title")}</h1>
        <p className="muted">
          {t.t("payments/pricing.empty.body")} <code>paddle</code> {t.t("payments/pricing.empty.body_end")}{" "}
          <code>pithy.config.ts</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>{t.t("payments/pricing.title")}</h1>
      <p className="muted">{t.t("payments/pricing.body")}</p>

      {/* Said once, at the top, and said before the click rather than after it. A purchase attaches to an
          account, so there has to be one; the visitor who has none learns that from a sentence and a
          named link, not from a redirect that lost what they were doing. */}
      {signedIn === false && <p className="muted">{t.t("payments/pricing.anonymous")}</p>}

      {/* A failed quote shows no price at all. Falling back to a figure written here would be the exact
          defect this screen exists to remove — and a wrong price is worse than a missing one, because a
          buyer only finds out at the card form. The button still works: checkout is Paddle's own, and it
          quotes again on its own page. */}
      {quoted.failure && <p className="muted">{failureText(t, quoted.failure)}</p>}
      {checkout.failure && <p className="muted">{failureText(t, checkout.failure)}</p>}
      {opened.failure && <p className="muted">{failureText(t, opened.failure)}</p>}

      <div className="stack">
        {products.map((product) => {
          const line = quoted.preview?.lines.find((quote) => quote.priceId === product.priceId) ?? null;
          const summary = line && quoted.preview ? priceSummary(quoted.preview, line) : null;
          const cycle = line ? every(t, line.billingCycle) : null;
          return (
            <div key={product.id}>
              <p>
                <strong>{product.name}</strong>
              </p>
              {/* Three states, and the middle one is the one that is easy to skip. A blank space where a
                  price goes is worse than a beat of waiting, and a beat of waiting is far better than a
                  number that corrects itself in front of the buyer. */}
              {quoted.loading ? (
                <p className="muted">{t.t("payments/pricing.loading")}</p>
              ) : summary ? (
                <p>
                  <strong>{summary.headline}</strong>
                  {cycle && <span className="muted"> {cycle}</span>}
                  {/* The honesty half of the quote, and the half that used to be dropped. Two things make
                      a figure an estimate and either is enough: the tax is not fully resolved — US tax
                      lives below the country and Paddle answers a country-only request with 0% — or the
                      location itself is a guess from an IP rather than the address the card is charged
                      from. Show what you know, label it, recalculate at the address: an estimate that
                      resolves at checkout is correct behaviour, and an estimate rendered as though it
                      were final is not. */}
                  {quoteIsEstimated(location, summary.estimated) && (
                    <span className="muted"> {t.t("payments/pricing.estimated")}</span>
                  )}
                  {summary.note && <span className="muted"> {summary.note}</span>}
                </p>
              ) : (
                <p className="muted">{t.t("payments/pricing.unavailable")}</p>
              )}
              {signedIn === false ? (
                signInPath && <Link to={signInPath}>{t.t("payments/pricing.sign_in", { product: product.name })}</Link>
              ) : (
                <button
                  type="button"
                  // Disabled while the session is still being read: a click that lands before the answer
                  // would take the guarded path anyway, which is the wall this screen exists to replace.
                  disabled={signedIn === null || checkout.starting || opened.opening}
                  onClick={() => void checkout.start(product.id)}
                >
                  {t.t("payments/pricing.buy", { product: product.name })}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Rendered from the handoff, and rendered before the checkout opens: Paddle finds this element by
          class name at the moment it opens, so the render revealing it has to commit first. That ordering
          is `usePaddleCheckout`'s job — get it wrong and Paddle throws out of your click handler. */}
      {opened.inline && <div className={CHECKOUT_FRAME} />}

      <div className="stack">
        <Link className="muted" to={subscriptionPath}>
          {t.t("payments/pricing.holdings")}
        </Link>
      </div>
    </main>
  );
}

export default function Pricing(): ReactNode {
  const signedIn = useSignedIn();
  // The two screens this one points at, each named by the job it does rather than by a path copied
  // into this file (#393).
  const signInPath = useOptionalScreenPath("sign-in");
  const subscriptionPath = useScreenPath("subscription");
  // Asked only once there is a session to ask about. A stranger's page makes no round trip for this —
  // there is nothing on file to fetch, and a marketing page should not wait on a request whose answer is
  // known in advance to be "nobody".
  const visitor = usePriceVisitor(signedIn === true, paymentsClient);
  return (
    <PricingScreen
      products={PADDLE_PRODUCTS}
      setup={paddleSetup}
      signedIn={signedIn}
      signInPath={signInPath}
      subscriptionPath={subscriptionPath}
      visitor={visitor}
      client={paymentsClient}
    />
  );
}
