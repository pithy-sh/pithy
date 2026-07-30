import { beforeAll, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import { mintAppStoreKey } from "../rails/apple/fixtures/chain";
import type { AppleHttpFetch } from "../rails/apple/http";
import { mintServiceAccountKey } from "../rails/google/fixtures/push";
import type { GoogleHttpFetch } from "../rails/google/http";
import { GOOGLE_TOKEN_URL } from "../rails/google/playApi";
import type { PaymentsProviderCredentials } from "../secret/registry";
import { batchedRailAccess } from "./railAccess";

/**
 * One page's rail access. Two properties are worth pinning, and both are about cost rather than correctness —
 * which is why they need a test: a pass that mints a token per purchase still produces the right answer, just
 * at twice the round-trips and with a signature per row.
 */

const NOW = new Date("2026-01-15T00:00:00.000Z");
const ACCESS_TOKEN = "ya29.a0ARrdaM-test-access-token";

let credentials: PaymentsProviderCredentials;

beforeAll(async () => {
  const appleKey = await mintAppStoreKey();
  const googleKey = await mintServiceAccountKey();
  credentials = {
    apple: {
      bundleId: "com.acme.app",
      keyId: "2X9R4HXF34",
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      privateKey: appleKey.pem,
    },
    google: {
      packageName: "com.acme.app",
      serviceAccountEmail: "pithy-play@acme-42.iam.gserviceaccount.com",
      privateKey: googleKey.pem,
      pubsubAudience: "https://acme.example/payments/webhooks/google",
    },
    stripe: {
      secretKey: "sk_test_pithyTestKeyNotARealOne00",
      webhookSecret: "whsec_pithyTestSigningSecretNotARealOne00",
    },
  };
});

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true, google: true, stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "pro_monthly" },
      stripe: { priceId: "price_1Abc" },
    },
  },
});

/** A Google transport that only ever answers the token endpoint, counting how often it is asked. */
function googleTransport(calls: string[]): GoogleHttpFetch {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: ACCESS_TOKEN }) };
  };
}

/** An Apple transport that answers nothing — building the provider must not reach the network at all. */
const appleTransport: AppleHttpFetch = async () => {
  throw new Error("building an Apple provider must not call the App Store Server API");
};

describe("batchedRailAccess", () => {
  test("mints Google's access token once for a page, however many purchases ask for the rail", async () => {
    // A hundred subscriptions on one page would otherwise sign a hundred assertions and POST a hundred times.
    const calls: string[] = [];
    const access = batchedRailAccess({
      config: CONFIG,
      credentials,
      now: NOW,
      trust: { googleTransport: googleTransport(calls) },
    });

    await Promise.all([access.providerFor("google"), access.providerFor("google"), access.providerFor("google")]);

    expect(calls.filter((url) => url === GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  test("mints nothing for a rail the page never touches", async () => {
    const calls: string[] = [];
    const access = batchedRailAccess({
      config: CONFIG,
      credentials,
      now: NOW,
      trust: { googleTransport: googleTransport(calls), appleTransport },
    });

    await access.providerFor("stripe");

    // Stripe authenticates with the secret key directly, so there is nothing to mint for it either.
    expect(calls).toEqual([]);
  });

  test("resolves each rail to its own provider", async () => {
    const access = batchedRailAccess({
      config: CONFIG,
      credentials,
      now: NOW,
      trust: { googleTransport: googleTransport([]), appleTransport },
    });
    expect((await access.providerFor("apple")).rail).toBe("apple");
    expect((await access.providerFor("google")).rail).toBe("google");
    expect((await access.providerFor("stripe")).rail).toBe("stripe");
  });

  test("a token the caller already minted is used rather than minted again", async () => {
    const calls: string[] = [];
    const access = batchedRailAccess({
      config: CONFIG,
      credentials,
      now: NOW,
      trust: { googleTransport: googleTransport(calls), googleAccessToken: "already-minted" },
    });
    await access.providerFor("google");
    expect(calls).toEqual([]);
  });

  test("a rail with no credentials refuses, and refuses the same way every time on the page", async () => {
    // The refusal is memoized with the provider, which is what keeps a page of rows on a switched-off rail
    // from attempting a mint each.
    const access = batchedRailAccess({
      config: CONFIG,
      credentials: { stripe: credentials.stripe },
      now: NOW,
      trust: { appleTransport },
    });
    await expect(access.providerFor("apple")).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
    await expect(access.providerFor("apple")).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
  });

  test("a rail turned off in config refuses even with credentials present", async () => {
    const appleOnly = PaymentsConfig.parse({
      rails: { apple: true },
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    const access = batchedRailAccess({ config: appleOnly, credentials, now: NOW, trust: { appleTransport } });
    await expect(access.providerFor("stripe")).rejects.toBeInstanceOf(PaymentsRailNotConfiguredError);
  });
});
