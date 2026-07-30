import { describe, expect, test } from "vitest";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import {
  PAYMENTS_PROVIDER_SECRET,
  PaymentsProviderCredentials,
  paymentsSecretsRegistry,
  railCredentials,
} from "./registry";

const APPLE = {
  bundleId: "com.acme.app",
  keyId: "2X9R4HXF34",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
};
const STRIPE = { secretKey: "sk_test_51Abc", webhookSecret: "whsec_test_51Abc" };

describe("paymentsSecretsRegistry", () => {
  test("declares exactly one secret — every rail's credentials live in it", () => {
    // One entry is the design, not an accident: a per-rail secret would mean a storage change and a
    // provisioning step every time a rail is added.
    expect(Object.keys(paymentsSecretsRegistry)).toEqual([PAYMENTS_PROVIDER_SECRET]);
  });

  test("declares the axes the reader routes on", () => {
    const entry = paymentsSecretsRegistry[PAYMENTS_PROVIDER_SECRET];
    expect(entry).toMatchObject({
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: true,
      valueType: "json",
    });
    // The schema is what the reader validates the decrypted value against, so a `json` entry without one
    // would resolve unvalidated credentials.
    expect(entry?.valueType === "json" && entry.schema).toBe(PaymentsProviderCredentials);
  });
});

describe("PaymentsProviderCredentials", () => {
  test("accepts one rail on its own", () => {
    expect(PaymentsProviderCredentials.parse({ apple: APPLE }).apple?.bundleId).toBe("com.acme.app");
  });

  test("accepts every rail at once", () => {
    const parsed = PaymentsProviderCredentials.parse({
      apple: APPLE,
      stripe: STRIPE,
      google: {
        packageName: "com.acme.app",
        serviceAccountEmail: "play@acme.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----",
        pubsubAudience: "https://api.acme.test/payments/webhooks/google",
      },
    });
    expect(Object.keys(parsed).sort()).toEqual(["apple", "google", "stripe"]);
  });

  test("accepts none — a project can compose payments before provisioning any rail", () => {
    expect(PaymentsProviderCredentials.parse({})).toEqual({});
  });

  test("refuses a partial rail credential", () => {
    // The case this guards: half of Stripe's pair provisioned, so the key works and every webhook signature
    // silently fails. Refusing at the read makes it a loud `secrets/invalid_value` instead.
    expect(() => PaymentsProviderCredentials.parse({ stripe: { secretKey: "sk_test_51Abc" } })).toThrow();
    expect(() => PaymentsProviderCredentials.parse({ apple: { bundleId: "com.acme.app" } })).toThrow();
    const { privateKey: _dropped, ...missingKey } = APPLE;
    expect(() => PaymentsProviderCredentials.parse({ apple: missingKey })).toThrow();
  });

  test("refuses an empty string where a credential is required", () => {
    expect(() => PaymentsProviderCredentials.parse({ stripe: { ...STRIPE, webhookSecret: "" } })).toThrow();
  });

  test("refuses an unknown rail, and an unknown field inside a rail", () => {
    // Strict on both levels: a typo'd rail name would otherwise provision credentials nothing ever reads,
    // and the operator would be left looking at a secret that exists and a rail that denies.
    expect(() => PaymentsProviderCredentials.parse({ amazon: { secretKey: "x" } })).toThrow();
    expect(() => PaymentsProviderCredentials.parse({ stripe: { ...STRIPE, publishableKey: "pk_test" } })).toThrow();
  });
});

describe("railCredentials", () => {
  test("returns the block for a provisioned rail", () => {
    const credentials = PaymentsProviderCredentials.parse({ apple: APPLE, stripe: STRIPE });
    expect(railCredentials(credentials, "apple").bundleId).toBe("com.acme.app");
    expect(railCredentials(credentials, "stripe").webhookSecret).toBe("whsec_test_51Abc");
  });

  test("a rail with no credentials is a 404, not a 500", async () => {
    const credentials = PaymentsProviderCredentials.parse({ apple: APPLE });
    expect(() => railCredentials(credentials, "google")).toThrow(PaymentsRailNotConfiguredError);
    try {
      railCredentials(credentials, "google");
    } catch (error) {
      const thrown = error as PaymentsRailNotConfiguredError;
      expect(thrown.payload.status).toBe(404);
      // The operator is told which of config and provisioning is missing; the client is told neither.
      expect(thrown.payload.detail).toContain(PAYMENTS_PROVIDER_SECRET);
      expect(thrown.payload.message).not.toContain(PAYMENTS_PROVIDER_SECRET);
    }
  });

  test("never puts a credential value in the refusal", async () => {
    const credentials = PaymentsProviderCredentials.parse({ stripe: STRIPE });
    try {
      railCredentials(credentials, "apple");
    } catch (error) {
      const rendered = JSON.stringify((error as PaymentsRailNotConfiguredError).payload);
      expect(rendered).not.toContain(STRIPE.secretKey);
      expect(rendered).not.toContain(STRIPE.webhookSecret);
    }
  });
});
