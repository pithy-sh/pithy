// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsConfig } from "../config/config";
import { productForProviderSku, railEnabled } from "../config/config";
import type { PaymentsRail } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import { type PaymentsProviderCredentials, railCredentials } from "../secret/registry";
import type { AppleHttpFetch } from "./apple/http";
import { appleRail } from "./apple/rail";
import type { PaymentsRailProvider } from "./contract";
import type { GoogleHttpFetch } from "./google/http";
import type { GoogleJwk } from "./google/oidc";
import { googleRail } from "./google/rail";
import type { LemonSqueezyHttpFetch } from "./lemonSqueezy/api";
import { lemonSqueezyRail } from "./lemonSqueezy/rail";
import type { PaddleHttpFetch } from "./paddle/api";
import { paddleRail } from "./paddle/rail";
import type { StripeHttpFetch } from "./stripe/api";
import { stripeRail } from "./stripe/rail";

/**
 * Which rails this build can speak to, and how one is resolved for a request.
 *
 * This is the single composition point. A rail arrives as one entry here plus its module — nothing else in
 * the package counts rails, and nothing branches on how many there are.
 *
 * **Two independent conditions, one answer.** A rail may be off in `pithy.config.ts`, or its credentials may
 * never have been provisioned, or this build may not implement it yet. All three are
 * `payments/rail_not_configured` (404), because from the caller's side they are the same statement — that
 * payment method is not available here — and distinguishing them in a response would describe our deployment
 * to a stranger. `detail` distinguishes them for the operator, which is where the distinction is useful.
 */

/**
 * The per-rail verification seams a caller may supply. Two kinds, and both are narrow on purpose.
 *
 * **Trust is additive only**, so nothing here can narrow production's trust: extra roots and extra keys are
 * *added* to each rail's pinned set, and a payload the extras do not cover is still checked against the store's
 * own. Each exists for callers with genuinely non-store signing material — the tests, which mint their own so
 * verification is exercised for real rather than stubbed, and the local development tools that do the same:
 * Xcode's StoreKit testing signs with a per-machine root, and a Pub/Sub emulator signs with a key Google never
 * saw.
 *
 * **Transport is a seam rather than a policy.** Google's rail cannot verify offline — Play hands out pointers,
 * not signed state — so it must reach the network, and a network call that could not be substituted could only be
 * tested through a stub of the module under test. One explicit parameter, defaulting to the runtime's `fetch`.
 * Every rail now has one, because every rail reaches its store on the reconciliation path even where it verifies
 * offline: a subscription nobody was notified about can only be learned by asking.
 *
 * **The two batch tokens are a cost seam, not a trust one.** Apple's API token and Google's OAuth token are each
 * bought with a signature and a round-trip, so a reconciliation pass over hundreds of purchases mints one and
 * passes it down rather than paying twice per purchase. They are parameters rather than a module cache because a
 * bearer credential derived from a secret is exactly what CLAUDE.md forbids caching in a module variable.
 */
export interface RailTrustOptions {
  /** Roots the Apple rail accepts in addition to Apple's pinned ones, base64 DER. */
  appleTrustedRoots?: readonly string[];
  /** The HTTP transport the Apple rail reaches the App Store Server API through. Defaults to `fetch`. */
  appleTransport?: AppleHttpFetch;
  /** An App Store Connect token already minted, so a batch of Apple refreshes pays for one. */
  appleApiToken?: string;
  /** Keys the Google rail accepts in addition to Google's published set, matched by `kid`. */
  googleTrustedKeys?: readonly GoogleJwk[];
  /** The HTTP transport the Google rail reaches Google's endpoints through. Defaults to `fetch`. */
  googleTransport?: GoogleHttpFetch;
  /** A Play access token already minted, so a batch of Google refreshes pays for one. */
  googleAccessToken?: string;
  /** The HTTP transport the Stripe rail reaches Stripe's API through. Defaults to `fetch`. */
  stripeTransport?: StripeHttpFetch;
  /** The HTTP transport the Lemon Squeezy rail reaches its API through. Defaults to `fetch`. */
  lemonSqueezyTransport?: LemonSqueezyHttpFetch;
  /** The HTTP transport the Paddle rail reaches its API through. Defaults to `fetch`. */
  paddleTransport?: PaddleHttpFetch;
}

/** Build a rail provider from the credential bundle. Each factory takes only its own rail's block. */
type RailFactory = (
  credentials: PaymentsProviderCredentials,
  trust: RailTrustOptions,
  config: PaymentsConfig,
) => PaymentsRailProvider;

/**
 * Every rail this build implements. A rail arrives as one entry here plus its module; an entry with no module
 * behind it would be a rail that reports itself available and then fails, which is worse than one that reports
 * itself absent.
 */
const RAIL_FACTORIES: Partial<Record<PaymentsRail, RailFactory>> = {
  apple: (credentials, trust) =>
    appleRail(railCredentials(credentials, "apple"), {
      trustedRoots: trust.appleTrustedRoots,
      transport: trust.appleTransport,
      apiToken: trust.appleApiToken,
    }),
  google: (credentials, trust) =>
    googleRail(railCredentials(credentials, "google"), {
      trustedKeys: trust.googleTrustedKeys,
      transport: trust.googleTransport,
      accessToken: trust.googleAccessToken,
    }),
  stripe: (credentials, trust) =>
    stripeRail(railCredentials(credentials, "stripe"), { transport: trust.stripeTransport }),
  lemonSqueezy: (credentials, trust, config) =>
    lemonSqueezyRail(railCredentials(credentials, "lemonSqueezy"), {
      transport: trust.lemonSqueezyTransport,
      // The catalog answers what the store's order object cannot: whether this variant is a subscription.
      // A Lemon Squeezy variant is one or the other and never both, so the product's declared type is the
      // whole answer — see `orderNotification` for why the rail must not guess it.
      sellsSubscription: (variantId) =>
        productForProviderSku(config, "lemonSqueezy", variantId)?.product.type === "subscription",
      // Without this the fixed-amount currency guard in `discounts.ts` never runs: it is written to skip
      // the check when the store's currency is unknown, and nothing was ever telling it. The catalog knows
      // — a `grants` clause names the currency a product's economy is denominated in.
      storeCurrency: config.lemonSqueezy?.storeCurrency,
    }),
  paddle: (credentials, trust, config) => {
    // Config is checked before this runs — `resolveRailProvider` refuses a disabled rail, and
    // `PaymentsConfig` refuses to parse with the rail on and the block absent — so this is the
    // "enabled, parsed, and somehow still absent" case rather than an adopter's missing three lines.
    const settings = config.paddle;
    if (settings === undefined) {
      throw new PaymentsRailNotConfiguredError({
        detail:
          "The paddle rail is on with no `paddle` settings block. Declare `clientToken`, `environment`, and `successUrl`.",
      });
    }
    return paddleRail(railCredentials(credentials, "paddle"), {
      environment: settings.environment,
      clientToken: settings.clientToken,
      checkout: settings.checkout,
      freshnessSeconds: settings.webhookFreshnessSeconds,
      storeCurrency: settings.storeCurrency,
      transport: trust.paddleTransport,
    });
  },
};

/** The rails this build can serve at all, whatever a project's config says. */
export function implementedRails(): readonly PaymentsRail[] {
  return Object.keys(RAIL_FACTORIES) as PaymentsRail[];
}

/**
 * The provider for one rail, or a 404.
 *
 * Config is checked before credentials, so a project that has not enabled a rail never triggers a credential
 * read for it — a read is a Secrets Store round-trip, and a disabled rail should not cost one.
 */
export function resolveRailProvider(
  rail: PaymentsRail,
  config: PaymentsConfig,
  credentials: PaymentsProviderCredentials,
  trust: RailTrustOptions = {},
): PaymentsRailProvider {
  if (!railEnabled(config, rail)) {
    throw new PaymentsRailNotConfiguredError({
      detail: `The ${rail} rail is off in this project's config. Set \`rails.${rail}: true\` and redeploy.`,
    });
  }
  const factory = RAIL_FACTORIES[rail];
  if (!factory) {
    throw new PaymentsRailNotConfiguredError({
      detail: `This build of @pithy-sh/payments implements ${implementedRails().join(", ")}, not ${rail}.`,
    });
  }
  return factory(credentials, trust, config);
}
