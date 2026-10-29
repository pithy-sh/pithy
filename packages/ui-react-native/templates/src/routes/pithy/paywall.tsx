import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { CHECKOUT_SESSION_PARAM, getEntitlements, submitPurchase } from "@pithy-sh/payments/src/client/api";
import { useCheckout } from "@pithy-sh/payments/src/client/hooks";
import type { PaymentsClientProduct } from "@pithy-sh/payments/src/client/projection";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  failureText,
  grantsProduct,
  PADDLE_IN_PAGE,
  paymentsClient,
  purchasePath,
  returningClient,
  useStoreSale,
} from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { onDevice } from "../../platform";
import { Link, useScreenPath, useSearchParam } from "../../router";
import { type Theme, useTheme } from "../../theme";
import { useAppFocus } from "../../useAppFocus";

export const path = "/paywall";

// The screen the router's entitlement guard sends people to. Rename `path` above and the guard follows, because it
// reads this claim rather than holding a copy of the string.
export const role = "paywall";

// Buying attaches a purchase to an account, so there has to be one.
export const session = "required";

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// It renders and styles; every call it makes belongs to @pithy-sh/payments and to `../../payments`. Each product
// sells through the rail this platform is set to in `pithy-config.generated.ts`: the App Store or Google Play in
// the app, a hosted checkout in the system browser on a phone, or nothing at all under `none`.

/**
 * This screen's English, baked in: the only catalog that survives being copied into your repository.
 *
 * `pithy.config.ts` is not in a message. A file name is not copy.
 */
const EN = {
  "payments/paywall.title": "Go further.",
  "payments/paywall.body": "Pick what you need. You can change your mind later.",
  "payments/paywall.buy": "Buy {product}",
  "payments/paywall.in_app": "Available in the app.",
  "payments/paywall.holdings": "What do I already have?",
  "payments/paywall.restore": "Restore purchases",
  "payments/paywall.nothing_to_restore": "The store has nothing to restore for this account.",
  "payments/paywall.restored_elsewhere": "Your purchases are restored. None of them includes what's sold here.",
  "payments/paywall.pending": "The store is still processing this purchase. It shows on your account once it clears.",
  "payments/paywall.empty.title": "Nothing for sale.",
  "payments/paywall.empty.body": "This project has no catalog yet. Add products to",
  "payments/paywall.done.title": "You're set.",
  "payments/paywall.done.body": "Thanks. Your purchase is on your account.",
  "payments/paywall.done.home": "Go home",
  "payments/checkout.in_page": "This checkout opens inside a web page, which the app can't show.",
  "payments/store.unavailable": "The store didn't answer. Try again in a moment.",
  "payments/store.no_answer":
    "The store hasn't answered. If the purchase goes through, it lands on your account on its own.",
  "payments/store.refused": "The store didn't finish the purchase.",
  "payments/store.no_token": "This device couldn't keep what tags a purchase as yours, so nothing was bought.",
  "payments/store.signed_out": "Sign in before you buy.",
} satisfies MessageCatalog;

/** One of this screen's buttons. The primary one is filled with the accent; the rest are outlined. */
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

export default function Paywall(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  const muted = [theme.type.body, { color: theme.colors.muted }];
  const subscriptionPath = useScreenPath("subscription");
  const sale = useStoreSale();

  // A hosted checkout on a phone happens in the system browser. The product the reader went to buy is held here,
  // and the entitlements are read again when the browser closes and when the app returns to the foreground; once
  // they grant what that product carries, the purchase has landed.
  const [awaiting, setAwaiting] = useState<PaymentsClientProduct | null>(null);
  const recheck = useRef<() => void>(() => undefined);
  const client = useMemo(() => returningClient(() => recheck.current()), []);
  const checkout = useCheckout(client);
  const held = useRead(
    "paywall-return",
    async () => {
      const result = await getEntitlements(paymentsClient);
      return result.ok ? result.value : [];
    },
    { skip: awaiting === null },
  );
  recheck.current = held.refresh;
  useAppFocus(() => {
    if (awaiting !== null) held.refresh();
  });

  // Coming back from Stripe's hosted Checkout, the success link carries the session id: on the web in the page's
  // query, on a phone in the universal link that opened the app. Posting it projects the purchase at once rather
  // than whenever the webhook lands. Once per return. No other rail puts a session id in its return link.
  const returned = useSearchParam(CHECKOUT_SESSION_PARAM) || null;
  const submitted = useRead(
    `checkout-return:${returned ?? ""}`,
    async () => (returned === null ? null : submitPurchase({ rail: "stripe", receipt: returned }, paymentsClient)),
    { skip: returned === null, once: true },
  ).value;
  const refused = submitted?.ok === false ? submitted.failure : null;

  if (!paymentsConfig.enabled) {
    return (
      <View
        style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
      >
        <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
          {t.t("payments/paywall.empty.title")}
        </Text>
        <Text style={muted}>
          {t.t("payments/paywall.empty.body")} <Text style={{ fontFamily: "monospace" }}>pithy.config.ts</Text>.
        </Text>
      </View>
    );
  }

  // A restore can bring back purchases this paywall does not sell; the reader is set only when one of them grants
  // a product on it.
  const restoredHere =
    sale.outcome === "restored" && paymentsConfig.products.some((product) => grantsProduct(product, sale.entitlements));
  const done =
    (returned !== null && submitted?.ok === true) ||
    sale.outcome === "bought" ||
    restoredHere ||
    (awaiting !== null && grantsProduct(awaiting, held.value ?? []));

  if (done) {
    return (
      <View
        style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
      >
        <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
          {t.t("payments/paywall.done.title")}
        </Text>
        <Text style={muted}>{t.t("payments/paywall.done.body")}</Text>
        <Link to="/">{t.t("payments/paywall.done.home")}</Link>
      </View>
    );
  }

  const offered = paymentsConfig.products.map((product) => ({ product, path: purchasePath(product) }));
  const sells = offered.some(({ path }) => path.kind !== "none");
  const storeRail = offered.find(({ path }) => path.kind === "store")?.path;
  const busy = checkout.starting || sale.busy;
  // Paddle answered with a checkout for Paddle.js to draw over a page. The app has no page to draw it on.
  const inPage = checkout.handoff === null ? null : PADDLE_IN_PAGE;

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("payments/paywall.title")}
      </Text>
      {sells && <Text style={muted}>{t.t("payments/paywall.body")}</Text>}

      {refused && <Text style={muted}>{failureText(t, refused)}</Text>}
      {checkout.failure && <Text style={muted}>{failureText(t, checkout.failure)}</Text>}
      {inPage && <Text style={muted}>{failureText(t, inPage)}</Text>}
      {sale.failure && <Text style={muted}>{failureText(t, sale.failure)}</Text>}
      {sale.outcome === "pending" && <Text style={muted}>{t.t("payments/paywall.pending")}</Text>}
      {sale.outcome === "nothing_to_restore" && <Text style={muted}>{t.t("payments/paywall.nothing_to_restore")}</Text>}
      {sale.outcome === "restored" && <Text style={muted}>{t.t("payments/paywall.restored_elsewhere")}</Text>}

      <View style={{ gap: theme.spacing.lg }}>
        {offered.map(({ product, path }) => (
          <View key={product.id} style={{ gap: theme.spacing.xs }}>
            <Text style={[theme.type.body, { color: theme.colors.text, fontWeight: "700" }]}>{product.name}</Text>
            {path.kind === "store" || path.kind === "hosted" ? (
              <Action
                theme={theme}
                primary
                label={t.t("payments/paywall.buy", { product: product.name })}
                disabled={busy}
                onPress={() => {
                  if (path.kind === "store") {
                    void sale.buy(path.rail, { sku: path.sku, type: product.type });
                    return;
                  }
                  if (onDevice()) setAwaiting(product);
                  void checkout.start(product.id, { rail: path.rail });
                }}
              />
            ) : path.kind === "none" ? (
              // Consumption only: what the plan includes, and nothing that sells it.
              product.entitlements.map((key) => (
                <Text key={key} style={muted}>
                  {key}
                </Text>
              ))
            ) : (
              // On the web, a product sold only through the App Store or Google Play can be named and nothing more.
              !onDevice() && <Text style={muted}>{t.t("payments/paywall.in_app")}</Text>
            )}
          </View>
        ))}
      </View>

      {/* The store's own history, for a reader on a new device or after a reinstall. */}
      {onDevice() && storeRail?.kind === "store" && (
        <Action
          theme={theme}
          label={t.t("payments/paywall.restore")}
          disabled={busy}
          onPress={() => void sale.restore(storeRail.rail)}
        />
      )}

      {sells && (
        <Link to={subscriptionPath} style={{ color: theme.colors.muted }}>
          {t.t("payments/paywall.holdings")}
        </Link>
      )}
    </View>
  );
}
