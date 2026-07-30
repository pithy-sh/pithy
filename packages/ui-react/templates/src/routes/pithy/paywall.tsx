import { returnedCheckoutSession } from "@pithy-sh/payments/src/client/api";
import { useCheckout, usePurchase } from "@pithy-sh/payments/src/client/hooks";
import { useEffect, useState } from "react";
import { paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link } from "../../router";

export const path = "/paywall";

// Buying attaches a purchase to an account, so there has to be one.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// It renders and styles; every call it makes belongs to @pithy-sh/payments. That split is the point — this
// file is written once and never rewritten, and store rules change. A purchase flow copied into here would
// be one Pithy could not fix for you; one that calls the hooks upgrades with a minor release.

/** What a product can do on the web. Apple and Google purchases happen inside a store SDK, not a browser. */
function purchasable(product: { stripePriceId: string | null }): boolean {
  return paymentsConfig.rails.stripe && product.stripePriceId !== null;
}

export default function Paywall() {
  const checkout = useCheckout(paymentsClient);
  const purchase = usePurchase(paymentsClient);
  const [returned] = useState(() => returnedCheckoutSession());

  // Coming back from hosted Checkout, the success URL carries the session id. Posting it projects the
  // purchase at once, so the entitlement shows now rather than whenever the webhook lands. The webhook is
  // still authoritative and still arrives; dropping this call would only cost the buyer a few seconds.
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

      <div className="stack">
        {paymentsConfig.products.map((product) => (
          <div key={product.id}>
            <p>
              <strong>{product.name}</strong>
            </p>
            {purchasable(product) ? (
              <button type="button" disabled={checkout.starting} onClick={() => void checkout.start(product.id)}>
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

      <div className="stack">
        <Link className="muted" to="/subscription">
          What do I already have?
        </Link>
      </div>
    </main>
  );
}
