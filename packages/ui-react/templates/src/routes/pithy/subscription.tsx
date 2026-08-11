import { useSubscription } from "@pithy-sh/payments/src/client/hooks";
import { paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link } from "../../router";
import "../../pithy-screens.css";

export const path = "/subscription";

// The entitlements shown are the caller's own; the server resolves them from the session.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

/**
 * What to say about one entitlement.
 *
 * `granted` comes first, and that ordering is the whole point: the server applies the expiry itself on every
 * read, so a row can come back `granted: false` while its own `expiresAt` still says nothing is wrong — a
 * refunded non-consumable is `{ granted: false, expiresAt: null }`, and reading only the date printed
 * "Yours to keep." over a purchase the user no longer has.
 */
function holding(entitlement: { granted: boolean; expiresAt: string | null }): string {
  if (!entitlement.granted) return entitlement.expiresAt === null ? "Ended." : "Ended, and not renewing.";
  return entitlement.expiresAt === null
    ? "Yours to keep."
    : `Renews ${new Date(entitlement.expiresAt).toLocaleDateString()}.`;
}

export default function Subscription() {
  const { entitlements, subscribed, loading, manage, manageStore, managing, failure, readFailure } =
    useSubscription(paymentsClient);

  if (loading) return <p className="muted">One moment.</p>;

  return (
    <main className="screen">
      {/* A read that failed is not an account that holds nothing. "Nothing yet." over an unreachable
          Worker tells a paying subscriber they have no subscription, and this screen is one click from
          the paywall that would sell them a second one. So the failure gets its own heading and the
          empty state is never rendered from an answer nobody received. */}
      <h1>{readFailure ? "We couldn't check." : subscribed ? "You're subscribed." : "Nothing yet."}</h1>

      {readFailure ? (
        <p className="muted">{readFailure.message}</p>
      ) : entitlements.length === 0 ? (
        <p className="muted">You don't hold anything on this account.</p>
      ) : (
        <div className="stack">
          {entitlements.map((entitlement) => (
            <p key={entitlement.key}>
              <strong>{entitlement.key}</strong> <span className="muted">{holding(entitlement)}</span>
            </p>
          ))}
        </div>
      )}

      {failure && <p className="muted">{failure.message}</p>}

      {/* Managing a subscription belongs to whoever sold it, under their own rules. Stripe's Billing
          Portal is a session the server mints; Apple's and Google's are pages in their own stores, and a
          web page cannot cancel a StoreKit or Play Billing subscription however much it would like to. */}
      <div className="stack">
        {/* Either hosted rail mints a portal session, and the server picks whichever one this caller
            actually bought on. Gating on Stripe alone left a Lemon-Squeezy-only project with no way to
            reach a portal that works. */}
        {(paymentsConfig.rails.stripe || paymentsConfig.rails.lemonSqueezy) && (
          <button type="button" disabled={managing} onClick={() => void manage()}>
            Manage billing
          </button>
        )}
        {paymentsConfig.rails.apple && (
          <button type="button" className="secondary" onClick={() => manageStore("apple")}>
            Bought on the App Store
          </button>
        )}
        {paymentsConfig.rails.google && (
          <button type="button" className="secondary" onClick={() => manageStore("google")}>
            Bought on Google Play
          </button>
        )}
        <Link className="muted" to="/paywall">
          See what else there is
        </Link>
      </div>
    </main>
  );
}
