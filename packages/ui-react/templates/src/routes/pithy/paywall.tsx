import {
  PAYMENTS_HOSTED_RAILS,
  type PaymentsHostedRail,
  returnedCheckoutSession,
} from "@pithy-sh/payments/src/client/api";
import { useCheckout, usePaddleCheckout, usePurchase } from "@pithy-sh/payments/src/client/hooks";
import { useEffect, useState } from "react";
import { paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link } from "../../router";
import "../../pithy-screens.css";

export const path = "/paywall";

// Buying attaches a purchase to an account, so there has to be one.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// It renders and styles; every call it makes belongs to @pithy-sh/payments. That split is the point — this
// file is written once and never rewritten, and store rules change. A purchase flow copied into here would
// be one Pithy could not fix for you; one that calls the hooks upgrades with a minor release.

/**
 * What a product can do on the web: any enabled hosted rail this product is actually listed on.
 *
 * The list is `PAYMENTS_HOSTED_RAILS`, from the package. It used to be three names written out here,
 * which is the shape #336 was about — correct on the day, one rail short a release later, and frozen
 * the moment this file was copied into a repo. Imported, a rail added to Pithy reaches a paywall
 * scaffolded a year ago. Apple and Google are not on it: those purchases happen inside a store SDK,
 * and a web page can say a product exists and nothing more.
 */
function purchasable(product: { skus: Record<PaymentsHostedRail, string | null> }): boolean {
  return PAYMENTS_HOSTED_RAILS.some((rail) => paymentsConfig.rails[rail] && product.skus[rail] !== null);
}

/**
 * The class Paddle renders an inline checkout into.
 *
 * A class name, not an id — that is Paddle's `frameTarget` contract. The container is rendered only when
 * the handoff asks for it, from `paddle.checkout` in your config: switch that to `inline` and the form
 * appears here instead of over the page, with no edit to this file. Style `.pithy-checkout` to place it.
 */
const CHECKOUT_FRAME = "pithy-checkout";

export default function Paywall() {
  const checkout = useCheckout(paymentsClient);
  // Paddle's overlay and inline modes never leave this page, so the handoff has to be opened here. Every
  // other hosted rail has already navigated away by the time `start` resolves and this reads null.
  const opened = usePaddleCheckout(checkout.handoff, { frameTarget: CHECKOUT_FRAME });
  const purchase = usePurchase(paymentsClient);
  const [returned] = useState(() => returnedCheckoutSession());

  // Coming back from hosted Checkout, the success URL carries the session id. Posting it projects the
  // purchase at once, so the entitlement shows now rather than whenever the webhook lands. The webhook is
  // still authoritative and still arrives; dropping this call would only cost the buyer a few seconds.
  //
  // Stripe only, and by construction rather than by a check: no other rail substitutes a session id into
  // the return URL, so `returned` is null coming back from one. A Lemon Squeezy buyer waits for the
  // webhook — that rail has no receipt a client could submit, because its order ids are sequential
  // integers and any authenticated caller could claim an order by counting.
  useEffect(() => {
    if (returned) void purchase.submit("stripe", returned);
    // The session id is read once, into state, so this runs once per return rather than once per render —
    // and `submit` is a stable callback, so listing it costs nothing and keeps the list honest.
  }, [returned, purchase.submit]);

  if (!paymentsConfig.enabled) {
    return (
      <main className="screen">
        <h1>Nothing for sale.</h1>
        <p className="muted">
          This project has no catalog yet. Add products to <code>pithy.config.ts</code>.
        </p>
      </main>
    );
  }

  if (returned && purchase.purchase) {
    return (
      <main className="screen">
        <h1>You're set.</h1>
        <p className="muted">Thanks. Your purchase is on your account.</p>
        <div className="stack">
          <Link to="/">Go home</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Go further.</h1>
      <p className="muted">Pick what you need. You can change your mind later.</p>

      {purchase.failure && <p className="muted">{purchase.failure.message}</p>}
      {checkout.failure && <p className="muted">{checkout.failure.message}</p>}
      {opened.failure && <p className="muted">{opened.failure.message}</p>}

      <div className="stack">
        {paymentsConfig.products.map((product) => (
          <div key={product.id}>
            <p>
              <strong>{product.name}</strong>
            </p>
            {purchasable(product) ? (
              <button
                type="button"
                disabled={checkout.starting || opened.opening}
                onClick={() => void checkout.start(product.id)}
              >
                Buy {product.name}
              </button>
            ) : (
              // Display only. StoreKit and Play Billing need native app code to present a purchase sheet,
              // so a web page can say a product exists and where to get it, and nothing more.
              <p className="muted">Available in the app.</p>
            )}
          </div>
        ))}
      </div>

      {/* Rendered from the handoff rather than from a guess at your config, and rendered *before* the
          checkout opens: Paddle looks this element up by class name at that moment, and throws if the
          render revealing it has not committed. That ordering is `usePaddleCheckout`'s job. */}
      {opened.inline && <div className={CHECKOUT_FRAME} />}

      <div className="stack">
        <Link className="muted" to="/subscription">
          What do I already have?
        </Link>
      </div>
    </main>
  );
}
