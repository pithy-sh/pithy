import { useCheckout, usePaddleCheckout, usePricePreview } from "@pithy-sh/payments/src/client/hooks";
import { priceSummary } from "@pithy-sh/payments/src/client/paddle";
import { paddleSetup, paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link } from "../../router";
import "../../pithy-screens.css";

export const path = "/pricing";

// No session. A pricing page is the one screen a stranger has to be able to read, and asking Paddle what
// this visitor pays needs nothing but the publishable token.

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

/** One quote per product, asked for in one round trip. Order matches {@link PADDLE_PRODUCTS}. */
const ITEMS = PADDLE_PRODUCTS.map((product) => ({ priceId: product.priceId, quantity: 1 }));

/**
 * What to load Paddle.js for, or null when there is nothing to quote.
 *
 * Null when the rail is off *and* when it is on with nothing listed on it. A quote for zero items is a
 * request Paddle refuses, and refusing it here costs a round trip and a failure message on a screen whose
 * honest state is "nothing priced here".
 */
const SETUP = ITEMS.length > 0 ? paddleSetup : null;

/**
 * The class Paddle renders an inline checkout into.
 *
 * A class name, not an id — that is Paddle's `frameTarget` contract. Whether it is used at all comes from
 * `paddle.checkout` in your config, through the handoff: switch that to `inline` and the card form appears
 * under the prices instead of over them, with no edit to this file. Style `.pithy-checkout` to place it.
 */
const CHECKOUT_FRAME = "pithy-checkout";

/** How often a price bills, in words. Null for a one-off, which needs no suffix. */
function every(cycle: { interval: string; frequency: number } | null): string | null {
  if (cycle === null) return null;
  return cycle.frequency === 1 ? `a ${cycle.interval}` : `every ${cycle.frequency} ${cycle.interval}s`;
}

export default function Pricing() {
  // The visitor's location is Paddle's to resolve, from their own IP. A signed-in app that knows better
  // passes `address` or `customerId` here; a marketing page does not know better.
  const quoted = usePricePreview(SETUP, { items: ITEMS });
  const checkout = useCheckout(paymentsClient);
  // The checkout opens over this page or inside it — it never navigates away, which is the whole reason
  // this rail has a pricing screen with a buy button on it rather than a link to somebody else's page.
  const opened = usePaddleCheckout(checkout.handoff, { frameTarget: CHECKOUT_FRAME });

  if (PADDLE_PRODUCTS.length === 0) {
    return (
      <main className="screen">
        <h1>Nothing priced here.</h1>
        <p className="muted">
          This screen prices what you sell through Paddle. Add a <code>paddle</code> block to a product in{" "}
          <code>pithy.config.ts</code>.
        </p>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>What it costs.</h1>
      <p className="muted">Prices are for where you are. Tax is Paddle's to calculate, not ours.</p>

      {/* A failed quote shows no price at all. Falling back to a figure written here would be the exact
          defect this screen exists to remove — and a wrong price is worse than a missing one, because a
          buyer only finds out at the card form. The button still works: checkout is Paddle's own, and it
          quotes again on its own page. */}
      {quoted.failure && <p className="muted">{quoted.failure.message}</p>}
      {checkout.failure && <p className="muted">{checkout.failure.message}</p>}
      {opened.failure && <p className="muted">{opened.failure.message}</p>}

      <div className="stack">
        {PADDLE_PRODUCTS.map((product) => {
          const line = quoted.preview?.lines.find((quote) => quote.priceId === product.priceId) ?? null;
          const summary = line && quoted.preview ? priceSummary(quoted.preview, line) : null;
          const cycle = line ? every(line.billingCycle) : null;
          return (
            <div key={product.id}>
              <p>
                <strong>{product.name}</strong>
              </p>
              {/* Three states, and the middle one is the one that is easy to skip. A blank space where a
                  price goes is worse than a beat of waiting, and a beat of waiting is far better than a
                  number that corrects itself in front of the buyer. */}
              {quoted.loading ? (
                <p className="muted">Getting your price.</p>
              ) : summary ? (
                <p>
                  <strong>{summary.headline}</strong>
                  {cycle && <span className="muted"> {cycle}</span>}
                  {summary.note && <span className="muted"> {summary.note}</span>}
                </p>
              ) : (
                <p className="muted">We couldn't get a price. You'll see it at checkout.</p>
              )}
              <button type="button" disabled={checkout.starting} onClick={() => void checkout.start(product.id)}>
                Buy {product.name}
              </button>
            </div>
          );
        })}
      </div>

      {/* Rendered from the handoff, and rendered before the checkout opens: Paddle finds this element by
          class name at the moment it opens, so the render revealing it has to commit first. That ordering
          is `usePaddleCheckout`'s job — get it wrong and Paddle throws out of your click handler. */}
      {opened.inline && <div className={CHECKOUT_FRAME} />}

      <div className="stack">
        <Link className="muted" to="/subscription">
          What do I already have?
        </Link>
      </div>
    </main>
  );
}
