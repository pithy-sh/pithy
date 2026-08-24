import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import {
  PAYMENTS_HOSTED_RAILS,
  type PaymentsClientOptions,
  type PaymentsClientRail,
} from "@pithy-sh/payments/src/client/api";
import { useSubscription } from "@pithy-sh/payments/src/client/hooks";
import type { ReactNode } from "react";
import { failureText, paymentsClient } from "../../payments";
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
 * This screen's English, baked in — the only catalog that survives being copied into your repository.
 *
 * The renewal date is not in here, and could not be: a date is `Intl`'s to render, in the reader's own
 * locale, from the translator's `formattingLocale`. What the message carries is the sentence around it.
 */
const EN = {
  "payments/subscription.subscribed": "You're subscribed.",
  "payments/subscription.empty": "Nothing yet.",
  "payments/subscription.unreadable": "We couldn't check.",
  "payments/subscription.nothing_held": "You don't hold anything on this account.",
  "payments/subscription.loading": "One moment.",
  "payments/subscription.holding.ended": "Ended.",
  "payments/subscription.holding.ended_not_renewing": "Ended, and not renewing.",
  "payments/subscription.holding.kept": "Yours to keep.",
  "payments/subscription.holding.renews": "Renews {date}.",
  "payments/subscription.manage": "Manage billing",
  "payments/subscription.apple": "Bought on the App Store",
  "payments/subscription.google": "Bought on Google Play",
  "payments/subscription.more": "See what else there is",
} satisfies MessageCatalog;

/**
 * What to say about one entitlement.
 *
 * `granted` comes first, and that ordering is the whole point: the server applies the expiry itself on every
 * read, so a row can come back `granted: false` while its own `expiresAt` still says nothing is wrong — a
 * refunded non-consumable is `{ granted: false, expiresAt: null }`, and reading only the date printed
 * "Yours to keep." over a purchase the holder no longer has.
 */
function holding(t: Translator, entitlement: { granted: boolean; expiresAt: string | null }): string {
  if (!entitlement.granted) {
    return entitlement.expiresAt === null
      ? t.t("payments/subscription.holding.ended")
      : t.t("payments/subscription.holding.ended_not_renewing");
  }
  if (entitlement.expiresAt === null) return t.t("payments/subscription.holding.kept");
  // The app's locale, not the browser's. A bare `toLocaleDateString()` follows whatever language the
  // device is set to, so a reader who chose Spanish inside a Spanish app still read an English date —
  // and on a right-to-left locale the two disagreed about direction as well.
  return t.t("payments/subscription.holding.renews", { date: t.formatDate(new Date(entitlement.expiresAt)) });
}

export interface SubscriptionScreenProps {
  /**
   * The translator this screen renders through.
   *
   * A prop for the reason `client` is: what a screen says in a second language is a *rendered* fact no
   * assertion about source text can reach. Absent, the screen reads the provider a `TranslatorProvider`
   * mounted, and with no provider it reads {@link EN}.
   */
  readonly t?: Translator;
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
export function SubscriptionScreen({ rails, client, paywallPath, t: given }: SubscriptionScreenProps): ReactNode {
  const { entitlements, subscribed, loading, manage, manageStore, managing, failure, readFailure } =
    useSubscription(client);
  // Called unconditionally, and chosen from afterwards: `given ?? useTranslator(EN)` would skip the hook
  // whenever the prop is passed, which is a hook count that changes between renders.
  const baked = useTranslator(EN);
  const t = given ?? baked;

  if (loading) return <p className="muted">{t.t("payments/subscription.loading")}</p>;

  return (
    <main className="screen">
      {/* A read that failed is not an account that holds nothing. "Nothing yet." over an unreachable
          Worker tells a paying subscriber they have no subscription, and this screen is one click from
          the paywall that would sell them a second one. So the failure gets its own heading and the
          empty state is never rendered from an answer nobody received. */}
      <h1>
        {readFailure
          ? t.t("payments/subscription.unreadable")
          : subscribed
            ? t.t("payments/subscription.subscribed")
            : t.t("payments/subscription.empty")}
      </h1>

      {readFailure ? (
        <p className="muted">{failureText(t, readFailure)}</p>
      ) : entitlements.length === 0 ? (
        <p className="muted">{t.t("payments/subscription.nothing_held")}</p>
      ) : (
        <div className="stack">
          {entitlements.map((entitlement) => (
            <p key={entitlement.key}>
              <strong>{entitlement.key}</strong> <span className="muted">{holding(t, entitlement)}</span>
            </p>
          ))}
        </div>
      )}

      {failure && <p className="muted">{failureText(t, failure)}</p>}

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
            {t.t("payments/subscription.manage")}
          </button>
        )}
        {/* Named one at a time, and correctly so: each store has its own sentence, and neither is a set. */}
        {rails.apple && (
          <button type="button" className="secondary" onClick={() => manageStore("apple")}>
            {t.t("payments/subscription.apple")}
          </button>
        )}
        {rails.google && (
          <button type="button" className="secondary" onClick={() => manageStore("google")}>
            {t.t("payments/subscription.google")}
          </button>
        )}
        <Link className="muted" to={paywallPath}>
          {t.t("payments/subscription.more")}
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
