import { describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsRail } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import { PaymentsProviderCredentials } from "../secret/registry";
import { isCheckoutRail } from "./contract";
import { implementedRails, resolveRailProvider } from "./providers";

const CREDENTIALS = PaymentsProviderCredentials.parse({
  apple: {
    bundleId: "com.acme.app",
    keyId: "2X9R4HXF34",
    issuerId: "57246542-96fe-1a63-e053-0824d011072a",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
  },
  google: {
    packageName: "com.acme.app",
    serviceAccountEmail: "pithy-play@acme-42.iam.gserviceaccount.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
    pubsubAudience: "https://acme.example/payments/webhooks/google",
  },
  stripe: {
    secretKey: "sk_test_pithyTestKeyNotARealOne00",
    webhookSecret: "whsec_pithyTestSigningSecretNotARealOne00",
  },
});

const config = (rails: Record<string, boolean>) =>
  PaymentsConfig.parse({
    rails,
    ...(rails.stripe
      ? {
          stripe: {
            successUrl: "https://acme.example/thanks",
            cancelUrl: "https://acme.example/pricing",
            portalReturnUrl: "https://acme.example/account",
          },
        }
      : {}),
    products: {
      pro_monthly: {
        type: "subscription",
        name: "Pro",
        entitlements: ["pro"],
        ...(rails.apple ? { apple: { productId: "com.acme.pro.monthly" } } : {}),
        ...(rails.google ? { google: { productId: "pro_monthly" } } : {}),
        ...(rails.stripe ? { stripe: { priceId: "price_1Abc" } } : {}),
      },
    },
  });

describe("resolveRailProvider", () => {
  test("resolves a rail that is enabled, implemented, and provisioned", () => {
    expect(resolveRailProvider("apple", config({ apple: true }), CREDENTIALS).rail).toBe("apple");
    expect(resolveRailProvider("google", config({ google: true }), CREDENTIALS).rail).toBe("google");
    expect(resolveRailProvider("stripe", config({ stripe: true }), CREDENTIALS).rail).toBe("stripe");
  });

  test("only Stripe initiates purchases, and the narrowing /checkout depends on says so", () => {
    // The asymmetry the contract refuses to paper over: Apple and Google hear about purchases, Stripe makes them.
    // `/checkout` and `/portal` narrow on this, so it is the assertion that keeps those routes honest.
    expect(isCheckoutRail(resolveRailProvider("stripe", config({ stripe: true }), CREDENTIALS))).toBe(true);
    expect(isCheckoutRail(resolveRailProvider("apple", config({ apple: true }), CREDENTIALS))).toBe(false);
    expect(isCheckoutRail(resolveRailProvider("google", config({ google: true }), CREDENTIALS))).toBe(false);
  });

  test("each rail gets only its own credential block", () => {
    // A rail that could see another's credentials is a rail that could send them somewhere. The factory takes
    // one block, and `railCredentials` is what refuses when it is absent.
    const thrown = catchError(() =>
      resolveRailProvider(
        "google",
        config({ google: true }),
        PaymentsProviderCredentials.parse({ apple: CREDENTIALS.apple }),
      ),
    );
    expect(thrown?.payload.detail).toContain("google rail has no credentials");
  });

  test("a rail that is off in config is a 404", () => {
    const thrown = catchError(() => resolveRailProvider("apple", config({ stripe: true }), CREDENTIALS));
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.status).toBe(404);
    expect(thrown?.payload.detail).toContain("off in this project's config");
  });

  test("a rail this build does not implement is the same 404 to a client, and distinguishable to an operator", () => {
    // Every rail in the union is implemented now, so this branch is only reachable through a config claiming one
    // that is not — which is exactly the shape of a future rail added to the enum before its module lands. Kept
    // and exercised rather than deleted: the day the fourth rail is half-added, this is the refusal it gets.
    const unimplemented = {
      ...config({ apple: true }),
      rails: { apple: false, google: false, stripe: false, amazon: true },
    };
    const thrown = catchError(() =>
      resolveRailProvider("amazon" as PaymentsRail, unimplemented as PaymentsConfig, CREDENTIALS),
    );
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.detail).toContain("implements apple, google, stripe");
  });

  test("an enabled, implemented rail with no credentials is a 404 too", () => {
    const thrown = catchError(() =>
      resolveRailProvider("apple", config({ apple: true }), PaymentsProviderCredentials.parse({})),
    );
    expect(thrown).toBeInstanceOf(PaymentsRailNotConfiguredError);
    expect(thrown?.payload.detail).toContain("no credentials");
  });

  test("no refusal tells a client which of config, build, or provisioning is missing", () => {
    // Three different causes, one public message. `detail` carries the difference and the HTTP codec strips it.
    const unimplemented = {
      ...config({ apple: true }),
      rails: { apple: false, google: false, stripe: false, amazon: true },
    };
    const messages = new Set(
      [
        catchError(() => resolveRailProvider("apple", config({ stripe: true }), CREDENTIALS)),
        catchError(() => resolveRailProvider("amazon" as PaymentsRail, unimplemented as PaymentsConfig, CREDENTIALS)),
        catchError(() => resolveRailProvider("apple", config({ apple: true }), PaymentsProviderCredentials.parse({}))),
      ].map((error) => error?.payload.message),
    );
    expect(messages.size).toBe(1);
  });
});

describe("implementedRails", () => {
  test("names what this build can serve — all three rails", () => {
    // The list is the honest answer to "which rails work". A rail added to config that is not here refuses
    // rather than half-working, and this assertion is what makes adding one a deliberate edit.
    expect(implementedRails()).toEqual(["apple", "google", "stripe"]);
  });
});

/** The thrown `PithyError`, or undefined. Keeps each case a single readable line. */
function catchError(run: () => unknown): PaymentsRailNotConfiguredError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as PaymentsRailNotConfiguredError;
  }
}
