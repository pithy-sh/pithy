import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import {
  PAYMENTS_HOSTED_RAILS,
  type PaymentsClientOptions,
  type PaymentsClientRail,
} from "@pithy-sh/payments/src/client/api";
import { useSubscription } from "@pithy-sh/payments/src/client/hooks";
import type { PaymentsRailChoice } from "@pithy-sh/payments/src/client/railChoice";
import { type ReactNode, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { failureText, returningClient } from "../../payments";
import { paymentsConfig, platformRails } from "../../pithy-config";
import { devicePlatform } from "../../platform";
import { Link, useScreenPath } from "../../router";
import { type Theme, useTheme } from "../../theme";
import { useAppFocus } from "../../useAppFocus";

export const path = "/subscription";

// What the paywall and the pricing screen link to as "what do I already have?". Rename `path` above and both
// follow, because they read this claim rather than keeping a copy of the string.
export const role = "subscription";

// The entitlements shown are the caller's own; the server resolves them from the session. Under a project that
// bills organizations they are the organization's, resolved from that same session. Either way this screen names no
// holder and cannot, which is what stops it becoming a way to read somebody else's.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.

/**
 * This screen's English, baked in: the only catalog that survives being copied into your repository.
 *
 * The renewal date is not in here, and could not be: a date is `Intl`'s to render, in the reader's own locale,
 * from the translator's `formattingLocale`. What the message carries is the sentence around it.
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
 * `granted` comes first: the server applies the expiry itself on every read, so a row can come back
 * `granted: false` while its own `expiresAt` still says nothing is wrong. A refunded non-consumable is
 * `{ granted: false, expiresAt: null }`, and reading only the date would print "Yours to keep." over a purchase the
 * holder no longer has.
 */
function holding(t: Translator, entitlement: { granted: boolean; expiresAt: string | null }): string {
  if (!entitlement.granted) {
    return entitlement.expiresAt === null
      ? t.t("payments/subscription.holding.ended")
      : t.t("payments/subscription.holding.ended_not_renewing");
  }
  if (entitlement.expiresAt === null) return t.t("payments/subscription.holding.kept");
  // The app's locale, not the device's: a reader who chose Spanish inside the app reads a Spanish date.
  return t.t("payments/subscription.holding.renews", { date: t.formatDate(new Date(entitlement.expiresAt)) });
}

/** One of this screen's buttons. The first is filled with the accent; the rest are outlined. */
function Action(props: {
  theme: Theme;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      disabled={props.disabled}
      aria-disabled={props.disabled}
      onPress={props.onPress}
      style={{
        borderWidth: 1,
        borderColor: props.primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: props.primary ? theme.colors.accent : "transparent",
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        alignSelf: "flex-start",
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: props.primary ? theme.colors.onAccent : theme.colors.text }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export interface SubscriptionScreenProps {
  /**
   * The translator this screen renders through. Absent, the screen reads the provider a `TranslatorProvider`
   * mounted, and with no provider it reads {@link EN}.
   */
  readonly t?: Translator;
  /**
   * Which rails the Worker sells through: `paymentsConfig.rails`. Keyed by the rail union rather than by `string`,
   * so a rail added to the package whose projection nobody widened stops compiling here.
   */
  readonly rails: Readonly<Record<PaymentsClientRail, boolean>>;
  /**
   * The rail this platform sells through, from `pithy-config.generated.ts`. `none` is a build that sells nothing:
   * it shows what the account holds and offers no way to buy or manage a purchase.
   */
  readonly choice: PaymentsRailChoice;
  /**
   * Where the payments routes are, and the fetch to reach them with. Absent, the app's own, with the system
   * browser's close reported back so the screen reads the subscription again.
   */
  readonly client?: PaymentsClientOptions;
  /** Where "see what else there is" points: the path the paywall screen declares, read through its role. */
  readonly paywallPath: string;
}

/**
 * The subscription screen, taking its projection rather than reading it, so a test mounts it against any set of
 * rails and looks for the buttons a reader would.
 *
 * Managing a subscription belongs to whoever sold it. A hosted rail's billing portal is a page the Worker mints,
 * which opens in the system browser on a phone; Apple's and Google's are pages in their own stores. Coming back to
 * the app reads the subscription again, so a cancellation shows the moment the reader returns.
 */
export function SubscriptionScreen({
  rails,
  choice,
  client,
  paywallPath,
  t: given,
}: SubscriptionScreenProps): ReactNode {
  const refreshAfter = useRef<() => void>(() => undefined);
  const returning = useMemo(() => returningClient(() => refreshAfter.current()), []);
  const { entitlements, subscribed, loading, refresh, manage, manageStore, managing, failure, readFailure } =
    useSubscription(client ?? returning);
  refreshAfter.current = refresh;
  useAppFocus(refresh);
  // Called unconditionally, and chosen from afterwards: `given ?? useTranslator(EN)` would skip the hook whenever
  // the prop is passed, which is a hook count that changes between renders.
  const baked = useTranslator(EN);
  const t = given ?? baked;
  const theme = useTheme();
  const muted = [theme.type.body, { color: theme.colors.muted }];

  if (loading) {
    return (
      <View style={{ flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.background }}>
        <Text style={muted}>{t.t("payments/subscription.loading")}</Text>
      </View>
    );
  }

  const sells = choice !== "none";

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      {/* A read that failed is not an account that holds nothing. "Nothing yet." over an unreachable Worker tells a
          paying subscriber they have no subscription, one tap from the paywall that would sell them a second. */}
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {readFailure
          ? t.t("payments/subscription.unreadable")
          : subscribed
            ? t.t("payments/subscription.subscribed")
            : t.t("payments/subscription.empty")}
      </Text>

      {readFailure ? (
        <Text style={muted}>{failureText(t, readFailure)}</Text>
      ) : entitlements.length === 0 ? (
        <Text style={muted}>{t.t("payments/subscription.nothing_held")}</Text>
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {entitlements.map((entitlement) => (
            <Text key={entitlement.key} style={[theme.type.body, { color: theme.colors.text }]}>
              <Text style={{ fontWeight: "700" }}>{entitlement.key}</Text>{" "}
              <Text style={{ color: theme.colors.muted }}>{holding(t, entitlement)}</Text>
            </Text>
          ))}
        </View>
      )}

      {failure && <Text style={muted}>{failureText(t, failure)}</Text>}

      {sells && (
        <View style={{ gap: theme.spacing.sm }}>
          {/* Every hosted rail mints a portal, and the Worker picks whichever one this account bought on. The list
              is the package's, so a rail added to Pithy reaches this screen without an edit. */}
          {PAYMENTS_HOSTED_RAILS.some((rail) => rails[rail]) && (
            <Action
              theme={theme}
              primary
              label={t.t("payments/subscription.manage")}
              disabled={managing}
              onPress={() => void manage()}
            />
          )}
          {/* Named one at a time: each store has its own sentence, and its own page. */}
          {rails.apple && (
            <Action theme={theme} label={t.t("payments/subscription.apple")} onPress={() => manageStore("apple")} />
          )}
          {rails.google && (
            <Action theme={theme} label={t.t("payments/subscription.google")} onPress={() => manageStore("google")} />
          )}
          <Link to={paywallPath} style={{ color: theme.colors.muted }}>
            {t.t("payments/subscription.more")}
          </Link>
        </View>
      )}
    </View>
  );
}

export default function Subscription(): ReactNode {
  // The paywall names itself; this reads the path it declared rather than keeping a copy.
  const paywallPath = useScreenPath("paywall");
  return (
    <SubscriptionScreen
      rails={paymentsConfig.rails}
      choice={platformRails[devicePlatform()]}
      paywallPath={paywallPath}
    />
  );
}
