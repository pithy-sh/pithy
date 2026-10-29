import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import type { Translator } from "@pithy-sh/core/src/i18n/translator";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import type { PaymentsClientOptions } from "@pithy-sh/payments/src/client/api";
import { useCheckout, usePricePreview } from "@pithy-sh/payments/src/client/hooks";
import { type PaddleOptions, type PaddleSetup, priceSummary } from "@pithy-sh/payments/src/client/paddle";
import type { PaymentsClientProduct } from "@pithy-sh/payments/src/client/projection";
import type { PaymentsPurchasePath } from "@pithy-sh/payments/src/client/railChoice";
import {
  type PriceVisitor,
  priceQueryFor,
  quoteIsEstimated,
  resolvePriceLocation,
} from "@pithy-sh/payments/src/pricing/location";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  failureText,
  PADDLE_IN_PAGE,
  paddleSetup,
  paymentsClient,
  purchasePath,
  type StoreItem,
  usePriceVisitor,
  useStoreListings,
  useStoreSale,
} from "../../payments";
import { paymentsConfig } from "../../pithy-config";
import { onDevice } from "../../platform";
import { Link, useOptionalScreenPath, useScreenPath, useSignedIn } from "../../router";
import { type Theme, useTheme } from "../../theme";

export const path = "/pricing";

// No session. A pricing page is the one screen a stranger has to be able to read. Buying does need an account, so
// a stranger is offered the way in, by name, before the tap.

// Pithy's screen. Yours to override: put your own file at this path under src/routes/app/ and it wins.
//
// Every figure on it comes from the store or from Paddle, for this reader. There is no price string in this file,
// and there must never be one: a number written here is wrong in every country whose tax convention differs from
// the one it was typed in, and it is wrong silently.
//
// What each product offers follows the rail this platform sells through, from `pithy-config.generated.ts`: the
// App Store or Google Play in the app, a hosted checkout (in the system browser on a phone), or, under `none`, the
// plan and what it includes with no price, no button and no link.

/**
 * This screen's English, baked in: the only catalog that survives being copied into your repository. No figure is
 * in here, and none ever may be.
 *
 * `{interval}` is Paddle's word for the billing period and arrives from their API rather than from a catalog.
 */
const EN = {
  "payments/pricing.title": "What it costs.",
  "payments/pricing.body": "Prices are for where you are. Tax is Paddle's to calculate, not ours.",
  "payments/pricing.store_body": "Prices are the store's, for where you are.",
  "payments/pricing.anonymous": "Anyone can read a price. Buying needs an account.",
  "payments/pricing.loading": "Getting your price.",
  "payments/pricing.estimated": "Estimated.",
  "payments/pricing.unavailable": "We couldn't get a price. You'll see it at checkout.",
  "payments/pricing.at_checkout": "You'll see the price at checkout.",
  "payments/pricing.sign_in": "Sign in to buy {product}",
  "payments/pricing.buy": "Buy {product}",
  "payments/pricing.done": "Thanks. Your purchase is on your account.",
  "payments/pricing.pending": "The store is still processing this purchase. It shows on your account once it clears.",
  "payments/pricing.holdings": "What do I already have?",
  "payments/pricing.every.one": "a {interval}",
  "payments/pricing.every.other": "every {count} {interval}s",
  "payments/pricing.empty.title": "Nothing priced here.",
  "payments/pricing.empty.rail":
    "Nothing here is sold through this platform's rail. Give a product its SKU on that rail in",
  "payments/checkout.in_page": "This checkout opens inside a web page, which the app can't show.",
  "payments/store.unavailable": "The store didn't answer. Try again in a moment.",
  "payments/store.no_answer":
    "The store hasn't answered. If the purchase goes through, it lands on your account on its own.",
  "payments/store.refused": "The store didn't finish the purchase.",
  "payments/store.no_token": "This device couldn't keep what tags a purchase as yours, so nothing was bought.",
  "payments/store.signed_out": "Sign in before you buy.",
} satisfies MessageCatalog;

/** How often a price bills, in words, through `plural`. Null for a one-off. */
function every(t: Translator, cycle: { interval: string; frequency: number } | null): string | null {
  if (cycle === null) return null;
  return t.plural("payments/pricing.every", cycle.frequency, { interval: cycle.interval });
}

/** One of this screen's buttons. */
function BuyButton(props: { theme: Theme; label: string; disabled: boolean; onPress: () => void }): ReactNode {
  const { theme } = props;
  return (
    <Pressable
      role="button"
      disabled={props.disabled}
      aria-disabled={props.disabled}
      onPress={props.onPress}
      style={{
        backgroundColor: theme.colors.accent,
        borderRadius: theme.radius,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        alignSelf: "flex-start",
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={[theme.type.button, { color: theme.colors.onAccent }]}>{props.label}</Text>
    </Pressable>
  );
}

export interface PricingScreenProps {
  /** The translator this screen renders through. Absent, the mounted provider's, and with none, {@link EN}. */
  readonly t?: Translator;
  /** The catalog. Products this platform cannot sell are left off. */
  readonly products: readonly PaymentsClientProduct[];
  /** How each product sells on this platform. */
  readonly pathFor: (product: PaymentsClientProduct) => PaymentsPurchasePath;
  /** What Paddle.js starts with, for a quote on the web; null on a phone and when the rail is off. */
  readonly setup: PaddleSetup | null;
  /** Whether there is a session: null while that is still being read. */
  readonly signedIn: boolean | null;
  /** Where "sign in to buy" points, or null in a project with no sign-in screen. */
  readonly signInPath: string | null;
  /** Where "what do I already have?" points: the subscription screen's declared path. */
  readonly subscriptionPath: string;
  /** Where this visitor is charged from, as far as is known, for a Paddle quote. */
  readonly visitor: PriceVisitor | null;
  /** Where the payments routes are, and the fetch to reach them with. Absent, the app's own. */
  readonly client?: PaymentsClientOptions;
  /** How Paddle.js is loaded. Injected so a test never reaches Paddle's CDN. */
  readonly paddle?: PaddleOptions;
}

/**
 * The pricing screen, taking its catalog and its visitor rather than reading them: an estimated quote has to look
 * estimated, an anonymous visitor has to be offered a way in, and a consumption-only build has to show no price.
 * Each is only true of what is rendered.
 */
export function PricingScreen({
  products,
  pathFor,
  setup,
  signedIn,
  signInPath,
  subscriptionPath,
  visitor,
  client,
  paddle,
  t: given,
}: PricingScreenProps): ReactNode {
  const baked = useTranslator(EN);
  const t = given ?? baked;
  const theme = useTheme();
  const muted = [theme.type.body, { color: theme.colors.muted }];

  const listed = products.flatMap((product) => {
    const path = pathFor(product);
    return path.kind === "unavailable" ? [] : [{ product, path }];
  });
  const storeItems: StoreItem[] = listed.flatMap(({ product, path }) =>
    path.kind === "store" ? [{ sku: path.sku, type: product.type }] : [],
  );
  const store = useStoreListings(storeItems);
  // A Paddle quote needs Paddle.js, which needs a browser: asked for on the web only, and only for what sells there.
  const quotable = setup === null ? [] : listed.filter(({ path }) => path.kind === "hosted" && path.rail === "paddle");
  const items = quotable.flatMap(({ product }) =>
    product.skus.paddle ? [{ priceId: product.skus.paddle, quantity: 1 }] : [],
  );
  const location = resolvePriceLocation(visitor);
  const quoted = usePricePreview(items.length > 0 ? setup : null, priceQueryFor(items, location), paddle);
  const checkout = useCheckout(client ?? paymentsClient);
  const sale = useStoreSale();

  if (listed.length === 0) {
    return (
      <View
        style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
      >
        <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
          {t.t("payments/pricing.empty.title")}
        </Text>
        <Text style={muted}>
          {t.t("payments/pricing.empty.rail")} <Text style={{ fontFamily: "monospace" }}>pithy.config.ts</Text>.
        </Text>
      </View>
    );
  }

  const sells = listed.some(({ path }) => path.kind !== "none");
  const busy = signedIn === null || checkout.starting || sale.busy;
  // Paddle answered with a checkout for Paddle.js to draw over a page. The app has no page to draw it on.
  const inPage = checkout.handoff === null ? null : PADDLE_IN_PAGE;

  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("payments/pricing.title")}
      </Text>
      {storeItems.length > 0 && <Text style={muted}>{t.t("payments/pricing.store_body")}</Text>}
      {quotable.length > 0 && <Text style={muted}>{t.t("payments/pricing.body")}</Text>}

      {sells && signedIn === false && <Text style={muted}>{t.t("payments/pricing.anonymous")}</Text>}

      {quoted.failure && <Text style={muted}>{failureText(t, quoted.failure)}</Text>}
      {checkout.failure && <Text style={muted}>{failureText(t, checkout.failure)}</Text>}
      {inPage && <Text style={muted}>{failureText(t, inPage)}</Text>}
      {sale.failure && <Text style={muted}>{failureText(t, sale.failure)}</Text>}
      {sale.outcome === "bought" && <Text style={muted}>{t.t("payments/pricing.done")}</Text>}
      {sale.outcome === "pending" && <Text style={muted}>{t.t("payments/pricing.pending")}</Text>}

      <View style={{ gap: theme.spacing.lg }}>
        {listed.map(({ product, path }) => (
          <View key={product.id} style={{ gap: theme.spacing.xs }}>
            <Text style={[theme.type.body, { color: theme.colors.text, fontWeight: "700" }]}>{product.name}</Text>
            {path.kind === "none" ? (
              // Consumption only: what the plan includes, and nothing that sells it.
              product.entitlements.map((key) => (
                <Text key={key} style={muted}>
                  {key}
                </Text>
              ))
            ) : (
              <>
                {path.kind === "store" ? (
                  // The store's own figure, in the reader's storefront currency with its tax convention.
                  store.loading ? (
                    <Text style={muted}>{t.t("payments/pricing.loading")}</Text>
                  ) : store.listings?.get(path.sku) ? (
                    <Text style={[theme.type.body, { color: theme.colors.text, fontWeight: "700" }]}>
                      {store.listings.get(path.sku)?.displayPrice}
                    </Text>
                  ) : (
                    <Text style={muted}>{t.t("payments/pricing.unavailable")}</Text>
                  )
                ) : path.rail === "paddle" && setup !== null ? (
                  <PaddleQuote t={t} theme={theme} product={product} quoted={quoted} location={location} />
                ) : (
                  <Text style={muted}>{t.t("payments/pricing.at_checkout")}</Text>
                )}
                {signedIn === false ? (
                  signInPath && (
                    <Link to={signInPath}>{t.t("payments/pricing.sign_in", { product: product.name })}</Link>
                  )
                ) : (
                  <BuyButton
                    theme={theme}
                    label={t.t("payments/pricing.buy", { product: product.name })}
                    disabled={busy}
                    onPress={() =>
                      void (path.kind === "store"
                        ? sale.buy(path.rail, { sku: path.sku, type: product.type })
                        : checkout.start(product.id, { rail: path.rail }))
                    }
                  />
                )}
              </>
            )}
          </View>
        ))}
      </View>

      {sells && (
        <Link to={subscriptionPath} style={{ color: theme.colors.muted }}>
          {t.t("payments/pricing.holdings")}
        </Link>
      )}
    </View>
  );
}

/** One product's Paddle quote: loading, the figure with its honesty labels, or no figure at all. */
function PaddleQuote(props: {
  t: Translator;
  theme: Theme;
  product: PaymentsClientProduct;
  quoted: ReturnType<typeof usePricePreview>;
  location: ReturnType<typeof resolvePriceLocation>;
}): ReactNode {
  const { t, theme, product, quoted, location } = props;
  const muted = [theme.type.body, { color: theme.colors.muted }];
  if (quoted.loading) return <Text style={muted}>{t.t("payments/pricing.loading")}</Text>;
  const line = quoted.preview?.lines.find((quote) => quote.priceId === product.skus.paddle) ?? null;
  const summary = line && quoted.preview ? priceSummary(quoted.preview, line) : null;
  if (!summary || !line) return <Text style={muted}>{t.t("payments/pricing.unavailable")}</Text>;
  const cycle = every(t, line.billingCycle);
  return (
    <Text style={[theme.type.body, { color: theme.colors.text }]}>
      <Text style={{ fontWeight: "700" }}>{summary.headline}</Text>
      {cycle && <Text style={{ color: theme.colors.muted }}> {cycle}</Text>}
      {/* An estimate is labelled before the tap: the tax is not fully resolved, or the location is a guess. */}
      {quoteIsEstimated(location, summary.estimated) && (
        <Text style={{ color: theme.colors.muted }}> {t.t("payments/pricing.estimated")}</Text>
      )}
      {summary.note && <Text style={{ color: theme.colors.muted }}> {summary.note}</Text>}
    </Text>
  );
}

export default function Pricing(): ReactNode {
  const signedIn = useSignedIn();
  const signInPath = useOptionalScreenPath("sign-in");
  const subscriptionPath = useScreenPath("subscription");
  const visitor = usePriceVisitor(signedIn === true && !onDevice(), paymentsClient);
  return (
    <PricingScreen
      products={paymentsConfig.enabled ? paymentsConfig.products : []}
      pathFor={purchasePath}
      setup={onDevice() ? null : paddleSetup}
      signedIn={signedIn}
      signInPath={signInPath}
      subscriptionPath={subscriptionPath}
      visitor={visitor}
    />
  );
}
