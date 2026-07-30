import type { PaymentsConfig } from "../config/config";
import type { PaymentsRail } from "../data/rail";
import { mintAppleApiToken } from "../rails/apple/serverApi";
import type { PaymentsRailProvider } from "../rails/contract";
import { mintPlayAccessToken } from "../rails/google/playApi";
import { type RailTrustOptions, resolveRailProvider } from "../rails/providers";
import { type PaymentsProviderCredentials, railCredentials } from "../secret/registry";

/**
 * How the reconciliation pass gets a rail, and why it is not simply `resolveRailProvider`.
 *
 * Two of the three rails buy their API access with a signature and a round-trip: Apple mints an ES256 App
 * Store Connect token, Google signs a service-account assertion and POSTs it for an OAuth token. Resolving a
 * rail per purchase would double every lookup — a hundred subscriptions would be two hundred round-trips and a
 * hundred signatures — so a batch mints once and passes the token down through {@link RailTrustOptions}.
 *
 * **Once per page, not once per run.** A minted token expires (Apple's inside the hour, Google's on the hour)
 * and a durable Workflow can be retried long after its first step ran, so a token held for a whole pass would
 * start failing part way through the very run that is meant to repair things. A page is bounded work inside
 * one step, which is exactly the lifetime a token comfortably covers — so the access object is built inside
 * each step and dropped with it.
 *
 * That also keeps the secret handling honest: a bearer credential derived from a secret is never cached in a
 * module variable, which is what CLAUDE.md requires and what a run-scoped cache would quietly become.
 */

/** One page's rail access: a provider per rail, with its batch token already minted. */
export interface ReconcileRailAccess {
  /** The provider for one rail. Throws `payments/rail_not_configured` when the rail is off or unprovisioned. */
  providerFor(rail: PaymentsRail): Promise<PaymentsRailProvider>;
}

/** What building one page's rail access needs: the catalog, the credentials, the clock, and the seams. */
export interface RailAccessOptions {
  /** The resolved catalog. Decides whether a rail is enabled at all. */
  config: PaymentsConfig;
  /** Every rail's credentials, read through the one reader by the caller. */
  credentials: PaymentsProviderCredentials;
  /** The clock. Dates each minted token. */
  now: Date;
  /** Transports and additional trust, forwarded to each rail. Empty in production. */
  trust?: RailTrustOptions;
}

/**
 * Build one page's rail access, minting each rail's batch token on first use.
 *
 * Lazy per rail: a page holding only Stripe purchases never signs an Apple assertion, and a project that
 * enabled one rail never pays for the other two. The mint happens inside `providerFor`, so a rail whose
 * credentials are missing raises `payments/rail_not_configured` at the same place a disabled rail does — one
 * refusal for the caller to handle rather than two.
 */
export function batchedRailAccess(options: RailAccessOptions): ReconcileRailAccess {
  const { config, credentials, now } = options;
  const base = options.trust ?? {};
  const built = new Map<PaymentsRail, Promise<PaymentsRailProvider>>();

  async function build(rail: PaymentsRail): Promise<PaymentsRailProvider> {
    const trust: RailTrustOptions = { ...base };
    if (rail === "apple" && trust.appleApiToken === undefined) {
      trust.appleApiToken = await mintAppleApiToken(railCredentials(credentials, "apple"), { now });
    }
    if (rail === "google" && trust.googleAccessToken === undefined) {
      trust.googleAccessToken = await mintPlayAccessToken(railCredentials(credentials, "google"), {
        now,
        transport: base.googleTransport,
      });
    }
    // Stripe authenticates every request with the secret key directly, so there is nothing to mint for it.
    return resolveRailProvider(rail, config, credentials, trust);
  }

  return {
    providerFor(rail: PaymentsRail): Promise<PaymentsRailProvider> {
      // The promise is memoized rather than its result, so two purchases on one rail in the same page cannot
      // both start a mint before either finishes.
      const existing = built.get(rail);
      if (existing) return existing;
      const pending = build(rail);
      built.set(rail, pending);
      return pending;
    },
  };
}
