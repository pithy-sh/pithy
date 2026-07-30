import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { z } from "zod";
import type { PaymentsRail } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";

/**
 * The one secret payments reads, and the shape of it.
 *
 * **One entry, three optional rails.** Every rail's credentials live inside a single JSON secret rather than
 * one secret per rail, and that is a storage decision worth stating: adding a rail then never reshapes
 * storage, never adds a binding to a `wrangler.jsonc`, and never needs a migration of the secrets store. It
 * is the arrangement `@pithy-sh/turnstile` uses for its per-mode widget keys, for the same reason — one
 * secret serves one *or* both, so the second costs nothing.
 *
 * A rail's block is present or entirely absent. There is no partial credential: `strictObject` with every
 * field required means an operator who supplies half of Stripe's pair gets a loud
 * `secrets/invalid_value` at the read rather than a signature check that silently never passes.
 *
 * ## Reading it
 *
 * `await sharedSecretsStore(env, paymentsSecretsRegistry)` then `.get(PAYMENTS_PROVIDER_SECRET)`, at the
 * point of need — never off a raw `env.X`, never through `CloudflareSecretsStoreManager`, never cached in a
 * module variable, and never spread into a log or an audit payload. Grep `sharedSecretsStore(` to find every
 * read site. `backend: "cf-secrets-store"` is the single place the storage location is decided; moving these
 * to `d1` is a one-line edit here and no change at any read site.
 *
 * `rotatable: true` because two of these genuinely rotate — Apple's App Store Connect key and Stripe's
 * webhook signing secret — and a verifier that must span a rotation reads `getVersions` instead of `get`.
 * Rotation changes nothing about how the value is stored, so declaring it now costs nothing and declaring it
 * later would be a registry edit during an incident.
 *
 * ## What is not here
 *
 * Apple's **root certificates**, because they are public: they ship in `rails/apple/certs.ts` as pinned
 * assets. Storing a public key as a secret would suggest the verification depends on its secrecy, and it does
 * not — it depends on it being *ours*.
 *
 * The **bundle id** is here, in Apple's block, and it is not secret either. It sits with the credentials
 * because it is part of the app's identity at Apple: it is what a notification is checked against, and it is
 * the `bid` claim an App Store Server API token carries. Splitting it into config would put one half of one
 * app's identity in git and the other in the secrets store.
 */

/** The name the credential bundle is stored and resolved under. The join key across every registry. */
export const PAYMENTS_PROVIDER_SECRET = "payments-provider-credentials";

export const PaymentsAppleCredentials = z
  .strictObject({
    bundleId: z
      .string()
      .min(1)
      .describe(
        "The app's bundle id. Not a secret, but part of the app's identity at Apple: every notification and receipt is checked against it, because an Apple signature proves Apple signed the payload and never that it is about this app.",
      ),
    keyId: z
      .string()
      .min(1)
      .describe("The App Store Connect API key id — the `kid` of the token that calls the App Store Server API."),
    issuerId: z
      .string()
      .min(1)
      .describe("The App Store Connect issuer id, from the Keys page. The `iss` of that same token."),
    privateKey: z
      .string()
      .min(1)
      .describe(
        "The App Store Connect private key, the `.p8` file's contents including its PEM header and footer. Downloadable exactly once from App Store Connect, so it is supplied rather than minted.",
      ),
  })
  .describe("Apple's credentials: the app's identity, and the App Store Connect key that signs server-API calls.");
export type PaymentsAppleCredentials = z.infer<typeof PaymentsAppleCredentials>;

export const PaymentsGoogleCredentials = z
  .strictObject({
    packageName: z
      .string()
      .min(1)
      .describe(
        "The Android application id. What a Play purchase token is looked up against, and the equivalent of Apple's bundle id.",
      ),
    serviceAccountEmail: z
      .string()
      .min(1)
      .describe(
        "The Google Cloud service account that reads the Play Developer API and is the audience of the Pub/Sub push token.",
      ),
    privateKey: z
      .string()
      .min(1)
      .describe(
        "The service account's private key, as the downloaded JSON's `private_key` field. Supplied, never minted.",
      ),
    pubsubAudience: z
      .string()
      .min(1)
      .describe(
        "The audience the Pub/Sub push OIDC token must claim. Checked on every notification: a token with the right signature and the wrong audience is one issued for somebody else's endpoint.",
      ),
  })
  .describe("Google's credentials: the app's identity, the Play Developer API service account, and the push audience.");
export type PaymentsGoogleCredentials = z.infer<typeof PaymentsGoogleCredentials>;

export const PaymentsStripeCredentials = z
  .strictObject({
    secretKey: z
      .string()
      .min(1)
      .describe(
        "The Stripe secret API key — `sk_live_…` or `sk_test_…`. Creates Checkout and Billing Portal sessions.",
      ),
    webhookSecret: z
      .string()
      .min(1)
      .describe(
        "The webhook endpoint's signing secret — `whsec_…`. What the `Stripe-Signature` HMAC is checked against, and the one Stripe rotates.",
      ),
  })
  .describe("Stripe's credentials: the secret key that creates hosted sessions, and the webhook signing secret.");
export type PaymentsStripeCredentials = z.infer<typeof PaymentsStripeCredentials>;

export const PaymentsProviderCredentials = z
  .strictObject({
    apple: PaymentsAppleCredentials.optional().describe("Apple's credentials, when the Apple rail is enabled."),
    google: PaymentsGoogleCredentials.optional().describe("Google's credentials, when the Google rail is enabled."),
    stripe: PaymentsStripeCredentials.optional().describe("Stripe's credentials, when the Stripe rail is enabled."),
  })
  .describe(
    "Every enabled rail's credentials, in one secret. A rail's block is present in full or absent entirely — adding a rail never reshapes storage.",
  );
export type PaymentsProviderCredentials = z.infer<typeof PaymentsProviderCredentials>;

/** Payments' secret-registry slice, aggregated into the shared accessor at worker startup. */
export const paymentsSecretsRegistry = defineSecretRegistry({
  [PAYMENTS_PROVIDER_SECRET]: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "json",
    schema: PaymentsProviderCredentials,
  },
});

/**
 * The credentials for one rail, or a refusal.
 *
 * A rail enabled in `pithy.config.ts` whose credentials were never provisioned is a 404, not a 500: from the
 * caller's side that payment method genuinely is not available here, and telling a client which of config or
 * provisioning is missing tells it about our deployment. `detail` carries the distinction for the operator.
 */
export function railCredentials<R extends PaymentsRail>(
  credentials: PaymentsProviderCredentials,
  rail: R,
): NonNullable<PaymentsProviderCredentials[R]> {
  const block = credentials[rail];
  if (!block) {
    throw new PaymentsRailNotConfiguredError({
      detail: `The ${rail} rail has no credentials in "${PAYMENTS_PROVIDER_SECRET}" for this environment. Run \`pithy secrets set\` for it.`,
    });
  }
  return block as NonNullable<PaymentsProviderCredentials[R]>;
}
