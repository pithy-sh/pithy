import {
  PAYMENTS_HOSTED_RAILS,
  type PaymentsClientOptions,
  type PaymentsClientRail,
} from "@pithy-sh/payments/src/client/api";
import { useSubscription } from "@pithy-sh/payments/src/client/hooks";
import type { ReactNode } from "react";
import { paymentsClient } from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { Link, useScreenPath } from "../../router";
import "../../pithy-screens.css";

export const path = "/subscription";

// What the paywall and the pricing screen link to as "what do I already have?". Rename `path` above and
// both follow, because they read this claim rather than keeping a copy of the string (#393).
export const role = "subscription";

// The entitlements shown are the caller's own; the server resolves them from the session. Under a project
// that bills organizations they are the organization's, resolved from that same session — either way this
// screen names no holder and cannot, which is what stops it becoming a way to read somebody else's.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

/**
 * What to say about one entitlement.
 *
 * `granted` comes first, and that ordering is the whole point: the server applies the expiry itself on every
 * read, so a row can come back `granted: false` while its own `expiresAt` still says nothing is wrong — a
 * refunded non-consumable is `{ granted: false, expiresAt: null }`, and reading only the date printed
 * "Yours to keep." over a purchase the holder no longer has.
 */
function holding(entitlement: { granted: boolean; expiresAt: string | null }): string {
  if (!entitlement.granted) return entitlement.expiresAt === null ? "Ended." : "Ended, and not renewing.";
  return entitlement.expiresAt === null
    ? "Yours to keep."
    : `Renews ${new Date(entitlement.expiresAt).toLocaleDateString()}.`;
}

export interface SubscriptionScreenProps {
  /**
   * Which rails this project sells through — `paymentsConfig.rails`.
   *
   * Keyed by the rail union rather than by `string`, and that is a gate: a rail added to the package
   * whose projection nobody widened stops compiling here, instead of reading `undefined` and rendering
   * nothing. `noUncheckedIndexedAccess` would hide that behind a `string` key.
   */
  readonly rails: Readonly<Record<PaymentsClientRail, boolean>>;
  /** Where the payments routes are, and the fetch to reach them with. Injected so a test never navigates. */
  readonly client?: PaymentsClientOptions;
  /**
   * Where "see what else there is" points — the path the paywall screen declares, read through the
   * role it claims rather than written out here. A literal survives the rename and stops answering
   * (#393).
   */
  readonly paywallPath: string;
}

/**
 * The subscription screen, taking its projection rather than reading it.
 *
 * A prop for the same reason `SignInScreen` takes one: which rails are on decides which buttons exist,
 * and that is a *rendered* fact no assertion about source text can reach. `subscription.test.tsx` mounts
 * this against a Paddle-only project and looks for the button — which is the whole of #336, checked the
 * way a user would check it.
 */
export function SubscriptionScreen({ rails, client, paywallPath }: SubscriptionScreenProps): ReactNode {
  const { entitlements, subscribed, loading, manage, manageStore, managing, failure, readFailure } =
    useSubscription(client);

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

      {/* Managing a subscription belongs to whoever sold it, under their own rules. A hosted rail's portal
          is a session the server mints; Apple's and Google's are pages in their own stores, and a web page
          cannot cancel a StoreKit or Play Billing subscription however much it would like to. */}
      <div className="stack">
        {/* Every hosted rail mints a portal, and the server picks whichever one this caller actually
            bought on. The list is the package's, not this file's: this gate was written out by hand
            twice and was one rail short both times (#336). A rail added to Pithy now reaches this
            screen without an edit, in a repo that copied it a year ago. */}
        {PAYMENTS_HOSTED_RAILS.some((rail) => rails[rail]) && (
          <button type="button" disabled={managing} onClick={() => void manage()}>
            Manage billing
          </button>
        )}
        {/* Named one at a time, and correctly so: each store has its own sentence, and neither is a set. */}
        {rails.apple && (
          <button type="button" className="secondary" onClick={() => manageStore("apple")}>
            Bought on the App Store
          </button>
        )}
        {rails.google && (
          <button type="button" className="secondary" onClick={() => manageStore("google")}>
            Bought on Google Play
          </button>
        )}
        <Link className="muted" to={paywallPath}>
          See what else there is
        </Link>
      </div>
    </main>
  );
}

export default function Subscription(): ReactNode {
  // The paywall names itself; this reads the path it declared rather than keeping a copy (#393).
  const paywallPath = useScreenPath("paywall");
  return <SubscriptionScreen rails={paymentsConfig.rails} client={paymentsClient} paywallPath={paywallPath} />;
}
