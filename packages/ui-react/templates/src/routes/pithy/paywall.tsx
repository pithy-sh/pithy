import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import {
  PAYMENTS_HOSTED_RAILS,
  type PaymentsHostedRail,
  returnedCheckoutSession,
} from "@pithy-sh/payments/src/client/api";
import { useCheckout, usePaddleCheckout, usePurchase } from "@pithy-sh/payments/src/client/hooks";
import { useEffect, useState } from "react";
// `CHECKOUT_FRAME` is imported rather than declared here: the two screens that sell share one class, and
// `.pithy-checkout` is a hook you are meant to style. Two copies is one styled checkout and one bare one.
import { CHECKOUT_FRAME, failureText, paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link, useScreenPath } from "../../router";
import "../../pithy-screens.css";

export const path = "/paywall";

// The screen the router's entitlement guard sends people to. Rename `path` above and the guard follows,
// because it reads this claim rather than holding a copy of the string (#393).
export const role = "paywall";

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
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * A project composing no `i18n` capability renders exactly these sentences. With it composed they
 * become the last layer: your own catalog first, then the kit's translation, then this.
 *
 * `pithy.config.ts` is not in a message. A file name is not copy, and a translator who rendered it in
 * their own language would name a file that does not exist.
 */
const EN = {
  "payments/paywall.title": "Go further.",
  "payments/paywall.body": "Pick what you need. You can change your mind later.",
  "payments/paywall.buy": "Buy {product}",
  "payments/paywall.in_app": "Available in the app.",
  "payments/paywall.holdings": "What do I already have?",
  "payments/paywall.empty.title": "Nothing for sale.",
  "payments/paywall.empty.body": "This project has no catalog yet. Add products to",
  "payments/paywall.done.title": "You're set.",
  "payments/paywall.done.body": "Thanks. Your purchase is on your account.",
  "payments/paywall.done.home": "Go home",
} satisfies MessageCatalog;

export default function Paywall() {
  const t = useTranslator(EN);
  // Read before the early returns, because it is a hook — and read at all, rather than written out as
  // `/subscription`, because the subscription screen declares its own path (#393).
  const subscriptionPath = useScreenPath("subscription");
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
        <h1>{t.t("payments/paywall.empty.title")}</h1>
        <p className="muted">
          {t.t("payments/paywall.empty.body")} <code>pithy.config.ts</code>.
        </p>
      </main>
    );
  }

  if (returned && purchase.purchase) {
    return (
      <main className="screen">
        <h1>{t.t("payments/paywall.done.title")}</h1>
        <p className="muted">{t.t("payments/paywall.done.body")}</p>
        <div className="stack">
          <Link to="/">{t.t("payments/paywall.done.home")}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>{t.t("payments/paywall.title")}</h1>
      <p className="muted">{t.t("payments/paywall.body")}</p>

      {purchase.failure && <p className="muted">{failureText(t, purchase.failure)}</p>}
      {checkout.failure && <p className="muted">{failureText(t, checkout.failure)}</p>}
      {opened.failure && <p className="muted">{failureText(t, opened.failure)}</p>}

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
                {t.t("payments/paywall.buy", { product: product.name })}
              </button>
            ) : (
              // Display only. StoreKit and Play Billing need native app code to present a purchase sheet,
              // so a web page can say a product exists and where to get it, and nothing more.
              <p className="muted">{t.t("payments/paywall.in_app")}</p>
            )}
          </div>
        ))}
      </div>

      {/* Rendered from the handoff rather than from a guess at your config, and rendered *before* the
          checkout opens: Paddle looks this element up by class name at that moment, and throws if the
          render revealing it has not committed. That ordering is `usePaddleCheckout`'s job. */}
      {opened.inline && <div className={CHECKOUT_FRAME} />}

      <div className="stack">
        <Link className="muted" to={subscriptionPath}>
          {t.t("payments/paywall.holdings")}
        </Link>
      </div>
    </main>
  );
}
