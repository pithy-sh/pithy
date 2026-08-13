// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { z } from "zod";

/**
 * The secrets `@pithy-sh/auth` reads, declared as a minimal registry. The secret name is the join key:
 * `secretsStore` resolves the same encrypted D1 row regardless of which capability's registry names it,
 * so auth never needs the project-wide registry to read its own secrets.
 *
 * - `auth-session-secret` — the Better Auth signing/encryption secret. Signs session cookies and the
 *   bearer HMAC, and encrypts the JWKS private keys at rest. Rotatable (Better Auth accepts a version
 *   set so a rotation keeps prior signatures valid).
 * - `auth-google-credentials` — the Google OAuth client id and secret together, as a typed JSON value.
 *   Both travel as one atomic secret so the credential pair is never split across config and store.
 *   Read only when the provider is enabled; rotated in Google Cloud Console, not on our schedule.
 * - `auth-apple-credentials` — the Apple Sign-In Services id, client secret, and (optional) app bundle
 *   id, as a typed JSON value. Apple's client secret is an ES256 JWT minted from the `.p8` key that
 *   expires (max 6 months), so this one is rotatable.
 * - `auth-facebook-credentials` — the Facebook Login app id and client secret, as a typed JSON value.
 *   Read only when the provider is enabled; rotated in the Meta app dashboard, not on our schedule.
 * - `auth-github-credentials` — the GitHub OAuth app client id and secret, as a typed JSON value.
 *   Read only when the provider is enabled; rotated in GitHub Developer settings, not on our schedule.
 */
export const AUTH_SESSION_SECRET = "auth-session-secret";
export const AUTH_GOOGLE_CREDENTIALS = "auth-google-credentials";
export const AUTH_APPLE_CREDENTIALS = "auth-apple-credentials";
export const AUTH_FACEBOOK_CREDENTIALS = "auth-facebook-credentials";
export const AUTH_GITHUB_CREDENTIALS = "auth-github-credentials";

/** The Google OAuth credential pair, stored as one typed JSON secret. */
export const GoogleOAuthCredentials = z
  .object({
    clientId: z
      .string()
      .describe(
        "The Google OAuth client id for this environment. Not secret on its own, but stored with the secret so the pair is atomic.",
      ),
    clientSecret: z
      .string()
      .describe("The Google OAuth client secret for this environment. Never committed, never an env literal."),
  })
  .describe("A Google OAuth client credential pair (`clientId` + `clientSecret`) for one environment.");
export type GoogleOAuthCredentials = z.infer<typeof GoogleOAuthCredentials>;

/** The Apple Sign-In credentials, stored as one typed JSON secret. */
export const AppleOAuthCredentials = z
  .object({
    clientId: z.string().describe("The Apple Sign-In Services id (the web OAuth client id) for this environment."),
    clientSecret: z
      .string()
      .describe(
        "The Apple client secret — an ES256 JWT minted from the `.p8` key. Expires (max 6 months), so rotate it on schedule.",
      ),
    appBundleIdentifier: z
      .string()
      .optional()
      .describe(
        "The native iOS app bundle id, used as the id-token audience for the native Sign-in-with-Apple flow. Optional.",
      ),
  })
  .describe(
    "An Apple Sign-In credential set (`clientId` + `clientSecret`, optional `appBundleIdentifier`) for one environment.",
  );
export type AppleOAuthCredentials = z.infer<typeof AppleOAuthCredentials>;

/** The Facebook Login credential pair, stored as one typed JSON secret. */
export const FacebookOAuthCredentials = z
  .object({
    clientId: z
      .string()
      .describe(
        "The Facebook Login app id for this environment. Not secret on its own, but stored with the secret so the pair is atomic.",
      ),
    clientSecret: z
      .string()
      .describe("The Facebook Login app secret for this environment. Never committed, never an env literal."),
  })
  .describe("A Facebook Login credential pair (`clientId` + `clientSecret`) for one environment.");
export type FacebookOAuthCredentials = z.infer<typeof FacebookOAuthCredentials>;

/** The GitHub OAuth credential pair, stored as one typed JSON secret. */
export const GithubOAuthCredentials = z
  .object({
    clientId: z
      .string()
      .describe(
        "The GitHub OAuth app client id for this environment. Not secret on its own, but stored with the secret so the pair is atomic.",
      ),
    clientSecret: z
      .string()
      .describe("The GitHub OAuth app client secret for this environment. Never committed, never an env literal."),
  })
  .describe("A GitHub OAuth credential pair (`clientId` + `clientSecret`) for one environment.");
export type GithubOAuthCredentials = z.infer<typeof GithubOAuthCredentials>;

/**
 * Where a human goes for each OAuth credential pair, and where the same human rotates it.
 *
 * **The settings page, not the product homepage.** The point is to end a search, not to start one — and
 * these four are the case with no command and no possible one, so the link is the entire remedy the kit
 * can offer. Named constants because origin and rotation are the same page for all four, and two copies
 * of a URL is one that goes stale.
 */
const GOOGLE_CREDENTIALS_PAGE = "https://console.cloud.google.com/apis/credentials";
const APPLE_KEYS_PAGE = "https://developer.apple.com/account/resources/authkeys/list";
const FACEBOOK_APPS_PAGE = "https://developers.facebook.com/apps/";
const GITHUB_OAUTH_APPS_PAGE = "https://github.com/settings/developers";

export const authSecretsRegistry = defineSecretRegistry({
  // `devValue` is the whole difference between an app that runs after `pithy add auth` and one that
  // signs nobody in: this secret is not a required binding, so nothing names it until the first
  // sign-in. Any random string signs a session — nothing outside the project has to agree with it.
  [AUTH_SESSION_SECRET]: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
    // `project` is the issuer, which is the whole reason this one is different: nobody outside validates
    // a session signature, so the kit both makes it and replaces it.
    origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
    rotation: { kind: "local" },
  },
  // The four below are `obtained` and rotate `manual`, and each names the page rather than the product.
  // An adopter searching Google's console for which of four credential types "client secret" means is the
  // gap this closes — and nothing will ever mint one, so saying where is the whole of what the kit can do.
  [AUTH_GOOGLE_CREDENTIALS]: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: GoogleOAuthCredentials,
    origin: { kind: "obtained", issuer: "google", documentation: GOOGLE_CREDENTIALS_PAGE },
    rotation: { kind: "manual", issuer: "google", documentation: GOOGLE_CREDENTIALS_PAGE },
  },
  [AUTH_APPLE_CREDENTIALS]: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "json",
    schema: AppleOAuthCredentials,
    origin: { kind: "obtained", issuer: "apple", documentation: APPLE_KEYS_PAGE },
    rotation: { kind: "manual", issuer: "apple", documentation: APPLE_KEYS_PAGE },
  },
  [AUTH_FACEBOOK_CREDENTIALS]: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: FacebookOAuthCredentials,
    origin: { kind: "obtained", issuer: "facebook", documentation: FACEBOOK_APPS_PAGE },
    rotation: { kind: "manual", issuer: "facebook", documentation: FACEBOOK_APPS_PAGE },
  },
  [AUTH_GITHUB_CREDENTIALS]: {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: GithubOAuthCredentials,
    origin: { kind: "obtained", issuer: "github", documentation: GITHUB_OAUTH_APPS_PAGE },
    rotation: { kind: "manual", issuer: "github", documentation: GITHUB_OAUTH_APPS_PAGE },
  },
});

/** Resolve the Better Auth session secret for this invocation. */
export async function resolveSessionSecret(env: SecretsStoreEnv): Promise<string> {
  const secrets = await sharedSecretsStore(env, authSecretsRegistry);
  return secrets.get(AUTH_SESSION_SECRET);
}

/** Resolve the Google OAuth credential pair for this invocation (only call when Google is enabled). */
export async function resolveGoogleCredentials(env: SecretsStoreEnv): Promise<GoogleOAuthCredentials> {
  const secrets = await sharedSecretsStore(env, authSecretsRegistry);
  return secrets.get(AUTH_GOOGLE_CREDENTIALS);
}

/** Resolve the Apple Sign-In credentials for this invocation (only call when Apple is enabled). */
export async function resolveAppleCredentials(env: SecretsStoreEnv): Promise<AppleOAuthCredentials> {
  const secrets = await sharedSecretsStore(env, authSecretsRegistry);
  return secrets.get(AUTH_APPLE_CREDENTIALS);
}

/** Resolve the Facebook Login credential pair for this invocation (only call when Facebook is enabled). */
export async function resolveFacebookCredentials(env: SecretsStoreEnv): Promise<FacebookOAuthCredentials> {
  const secrets = await sharedSecretsStore(env, authSecretsRegistry);
  return secrets.get(AUTH_FACEBOOK_CREDENTIALS);
}

/** Resolve the GitHub OAuth credential pair for this invocation (only call when GitHub is enabled). */
export async function resolveGithubCredentials(env: SecretsStoreEnv): Promise<GithubOAuthCredentials> {
  const secrets = await sharedSecretsStore(env, authSecretsRegistry);
  return secrets.get(AUTH_GITHUB_CREDENTIALS);
}
