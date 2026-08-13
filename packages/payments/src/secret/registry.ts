// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
 * read site. `backend` is the single place the storage location is decided; moving this bundle to the
 * Cloudflare Secrets Store would be a one-line edit here (plus a binding) and no change at any read site.
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

/**
 * Where a human goes for these credentials, and where the same human replaces them.
 *
 * **Four consoles, one `issuer` field.** Apple's `.p8`, Google's service-account key, Stripe's key pair
 * and Lemon Squeezy's API key are each taken by hand from a different company's console, and they share
 * one secret because they share one storage decision (see above) — not because they share an issuer. The
 * axis holds a single name, so the honest one is `other`: *somebody issues this, and it is not one
 * somebody.* Naming any single rail would be wrong for every deployment that does not sell through it.
 *
 * So the link is the one page that names all four rather than a rail's settings page. The point of the
 * field is to end a search; a link to Stripe ends a quarter of this one. The day this bundle is split per
 * rail — or `SecretOrigin` grows an issuer per entry — each half names its own console and this constant
 * goes.
 */
const PAYMENTS_CREDENTIALS_PAGE = "https://github.com/pithy-sh/pithy/blob/main/docs/commands/payments.md";

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

export const PaymentsLemonSqueezyCredentials = z
  .strictObject({
    apiKey: z
      .string()
      .min(1)
      .describe(
        "The Lemon Squeezy API key. Creates hosted checkouts, reads orders and subscriptions, and mints customer-portal links. Account-wide: it returns test-mode objects to a production deployment too, which is why `test_mode` on the object — never the key — decides a purchase's environment.",
      ),
    webhookSecret: z
      .string()
      .min(1)
      .describe(
        "The webhook's signing secret, set when the webhook is created. What the `X-Signature` HMAC-SHA256 over the exact received body is checked against.",
      ),
    storeId: z
      .string()
      .min(1)
      .describe(
        "The Lemon Squeezy store id this deployment sells through. Account-level identity, the way Apple's `bundleId` is, which is why it sits with the credentials rather than in config.",
      ),
  })
  .describe("Lemon Squeezy's credentials: the API key, the webhook signing secret, and the store's identity.");
export type PaymentsLemonSqueezyCredentials = z.infer<typeof PaymentsLemonSqueezyCredentials>;

export const PaymentsProviderCredentials = z
  .strictObject({
    apple: PaymentsAppleCredentials.optional().describe("Apple's credentials, when the Apple rail is enabled."),
    google: PaymentsGoogleCredentials.optional().describe("Google's credentials, when the Google rail is enabled."),
    stripe: PaymentsStripeCredentials.optional().describe("Stripe's credentials, when the Stripe rail is enabled."),
    lemonSqueezy: PaymentsLemonSqueezyCredentials.optional().describe(
      "Lemon Squeezy's credentials, when that rail is enabled.",
    ),
  })
  .describe(
    "Every enabled rail's credentials, in one secret. A rail's block is present in full or absent entirely — adding a rail never reshapes storage.",
  );
export type PaymentsProviderCredentials = z.infer<typeof PaymentsProviderCredentials>;

/** Payments' secret-registry slice, aggregated into the shared accessor at worker startup. */
export const paymentsSecretsRegistry = defineSecretRegistry({
  [PAYMENTS_PROVIDER_SECRET]: {
    // An encrypted row in the per-environment secrets D1 — where this bundle actually lives. No
    // wrangler template binds it from the Cloudflare Secrets Store; `pithy payments provision` writes
    // it through `dispatchSecretWrite` → the manager Workflow → `SystemSecretsStore`, the D1 path.
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "json",
    schema: PaymentsProviderCredentials,
    // `obtained`, and it always will be: a rail's key authenticates against that rail, so a minted one
    // authenticates against nothing and hides the real gap behind a filled-in field.
    origin: { kind: "obtained", issuer: "other", documentation: PAYMENTS_CREDENTIALS_PAGE },
    // `manual`, and note it does not follow from `rotatable: true`. `rotatable` says the store may hold
    // two live versions of this bundle at once — which it must, because a Stripe webhook signed under
    // the old secret can arrive after the new one is written. Who performs the replacement is a human in
    // a console, whatever the store can hold while they do it.
    rotation: { kind: "manual", issuer: "other", documentation: PAYMENTS_CREDENTIALS_PAGE },
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
