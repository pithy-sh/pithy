// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type {
  AppleOAuthCredentials,
  FacebookOAuthCredentials,
  GithubOAuthCredentials,
  GoogleOAuthCredentials,
} from "./secrets";

/**
 * What one social provider *is*, for one instance — three states, carried on the value (#381).
 *
 * ## Why three
 *
 * A provider used to be `Credentials | undefined`, and that shape had room for two facts and needed
 * room for three. `undefined` meant "the adopter did not enable this"; there was no way to say "the
 * adopter enabled it and its credential would not read", so that third fact was expressed by the only
 * means left — the resolution rejecting, inside a `Promise.all` that also carried the session secret.
 * One unreadable `auth-github-credentials` therefore took down magic link and OTP for every user,
 * because a contributor to sign-in was wired as a precondition of it.
 *
 * The session secret and the D1 binding really are preconditions: without either there is no sign-in of
 * any kind, and they keep failing the whole instance. A provider is one method among several.
 *
 * ## Why on the value
 *
 * This is #350's shape, applied to a provider rather than an aggregate. The credentials live *behind*
 * the healthy member, so a call site reaches `clientId` only by narrowing on `state`, and one that
 * forgets the sick case does not silently build a provider out of nothing — it does not compile. A flag
 * beside an optional credential would be the same information and the opposite property.
 *
 * ## Why `unresolvable` carries nothing
 *
 * {@link resolveProvider}'s `catch` takes no binding, so nothing derived from the throw is in reach to
 * put here. That is deliberate rather than incidental: what a secret resolution throws is a
 * `SecretNotFoundError` whose `message` names `auth-github-credentials`, or a schema failure whose
 * issues quote what was stored. Neither may reach a browser. Everything the refusal needs — *which*
 * provider — is known at the call site from the key it was resolved under, so it never has to be
 * recovered from an error.
 */
export type ResolvedProvider<Credentials> =
  | { readonly state: "disabled" }
  | { readonly state: "ready"; readonly credentials: Credentials }
  | { readonly state: "unresolvable" };

/**
 * The one `disabled` value, so the state has one spelling.
 *
 * Typed as the bare member rather than `ResolvedProvider<never>`: it is assignable to every
 * `ResolvedProvider<C>` either way, and this way nothing can read a `credentials` off it by widening.
 */
export const PROVIDER_DISABLED: { readonly state: "disabled" } = { state: "disabled" };

/** The social providers the kit composes. Ordered as they are declared in config. */
export const SOCIAL_PROVIDER_IDS = ["google", "apple", "facebook", "github"] as const;

/** One of the kit's social providers. */
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

/**
 * Every provider's state for one instance.
 *
 * A record rather than four loose fields, because two things read it — the `socialProviders` block the
 * instance is built from, and the refusal that answers a caller who asked for one that is not there —
 * and they must be reading the same four values or they will disagree about what is available.
 */
export interface ResolvedProviders {
  /** Google OAuth: disabled, ready with its credential pair, or declared and unreadable. */
  google: ResolvedProvider<GoogleOAuthCredentials>;
  /** Apple Sign-In: disabled, ready with its credential set, or declared and unreadable. */
  apple: ResolvedProvider<AppleOAuthCredentials>;
  /** Facebook Login: disabled, ready with its credential pair, or declared and unreadable. */
  facebook: ResolvedProvider<FacebookOAuthCredentials>;
  /** GitHub OAuth: disabled, ready with its credential pair, or declared and unreadable. */
  github: ResolvedProvider<GithubOAuthCredentials>;
}

/**
 * Every provider disabled — what a composition that enables no social sign-in resolves to, and the
 * base a construction site spreads over rather than spelling four times.
 */
export const NO_SOCIAL_PROVIDERS: Readonly<ResolvedProviders> = {
  google: PROVIDER_DISABLED,
  apple: PROVIDER_DISABLED,
  facebook: PROVIDER_DISABLED,
  github: PROVIDER_DISABLED,
};

/**
 * Resolve one provider: `disabled` when the adopter did not enable it, `ready` with its credentials, or
 * `unresolvable` when it is enabled and the read failed.
 *
 * **`try`/`catch`, and `read` is invoked inside it.** A `.catch()` on the returned promise would guard
 * only a rejection, and a seam that throws *before* it returns a promise is not a rejected promise —
 * that is how #371's first plant walked straight through its own guard. Calling `read()` inside the
 * `try` catches both, and `providers.test.ts` plants a synchronous throw to prove it.
 *
 * **The `catch` takes no binding.** See {@link ResolvedProvider} — what a secret resolution throws
 * names the secret, and nothing derived from it may travel toward a browser.
 */
export async function resolveProvider<Credentials>(
  enabled: boolean,
  read: () => Promise<Credentials>,
): Promise<ResolvedProvider<Credentials>> {
  if (!enabled) return PROVIDER_DISABLED;
  try {
    return { state: "ready", credentials: await read() };
  } catch {
    return { state: "unresolvable" };
  }
}

/**
 * The Better Auth endpoints that name a social provider in their body, as their `ctx.path` reads —
 * mounted paths, so no `basePath` appears here.
 *
 * `/callback/:provider` is deliberately absent: a callback can only arrive for a provider that already
 * served an authorize redirect, and an unresolvable one never did.
 */
const PROVIDER_BODY_PATHS: ReadonlySet<string> = new Set(["/sign-in/social", "/link-social"]);

/**
 * The provider named in a social sign-in body.
 *
 * Parsed rather than cast. Better Auth has already validated the body against the endpoint's own
 * schema by the time a `before` hook runs, so this is not the trust boundary — but a `catchall` shape
 * read with a cast is how a hook starts reading a field that is not there, and `unknown` narrows for
 * free here.
 */
const ProviderBody = z
  .object({
    provider: z.string().min(1).describe("The social provider id the caller asked to sign in or link with."),
  })
  .describe("The part of a social sign-in body this refusal reads: which provider was asked for.");

/**
 * Which provider this request asks for, when the request is one that names one and that provider is
 * enabled but unreadable. `undefined` for every other request, which is nearly all of them.
 *
 * A provider that is merely *disabled* is not this function's business: Better Auth answers that with
 * its own `PROVIDER_NOT_FOUND` 404, which is the right answer — nobody configured it. This exists so
 * the two stop looking alike from outside the Worker.
 */
export function unavailableProviderFor(
  path: string,
  body: unknown,
  providers: ResolvedProviders,
): SocialProviderId | undefined {
  if (!PROVIDER_BODY_PATHS.has(path)) return undefined;
  const parsed = ProviderBody.safeParse(body);
  if (!parsed.success) return undefined;
  const asked = SOCIAL_PROVIDER_IDS.find((id) => id === parsed.data.provider);
  if (!asked) return undefined;
  return providers[asked].state === "unresolvable" ? asked : undefined;
}

/**
 * The refusal a caller gets for a provider this deployment means to serve and cannot.
 *
 * Three audiences, three fields, exactly as the error family prescribes:
 *
 * - `message` is the caller's, and it is the whole of what crosses the wire. It says the method is
 *   unavailable *right now* and names one that works, because a 404 saying "provider not found" tells
 *   somebody who signs in with GitHub every day that they were wrong about their own account.
 * - `action` is the operator's — the command that fixes it, and the config key that turns it off.
 * - `detail` is the throw site's. It names the provider and says the credential would not resolve. It
 *   does **not** carry the resolution's own error: `resolveProvider` dropped that whole, on purpose.
 *
 * `503` rather than `500`, and rather than `404`. This deployment's own dependency — the credential row
 * for one sign-in method — is the thing that could not be served, which is what 503 means and what
 * `payments/provider_unavailable` already uses it for. A 404 would be indistinguishable from a provider
 * nobody enabled, and that indistinguishability is the defect.
 */
export function providerUnavailable(provider: SocialProviderId): PithyError {
  return new PithyError({
    code: "auth/provider_unavailable",
    status: 503,
    message: `Signing in with ${provider} is unavailable right now. Use a magic link instead.`,
    action: `Provision \`auth-${provider}-credentials\` for this environment with \`pithy secrets create\`, or set \`${provider}.enabled\` to false in pithy.config.ts.`,
    detail: `provider ${provider} is enabled and its credential could not be resolved; the instance was built without it`,
  });
}
