// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WebhookUnverifiedError } from "@pithy-sh/core/src/error/pithyError";
import { type JwksCache, OidcClaims, OidcJwk, OidcJwks, verifyOidcToken } from "@pithy-sh/core/src/http/oidcWebhook";
import { z } from "zod";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { GoogleHttpFetch } from "./http";

/**
 * The authenticity boundary on Google's webhook: the OIDC token a Pub/Sub push carries.
 *
 * Play's Real-time Developer Notifications do not arrive from Google Play. They arrive from **Pub/Sub**, which
 * POSTs to a URL an operator configured, carrying a Google-signed OIDC token in the `Authorization` header.
 * So there is no signature over the body the way Apple signs a notification — the token is the proof, and what
 * it proves is narrow.
 *
 * **The audience check is the actual boundary.** Google signs these tokens with the same handful of keys for
 * every push subscription on the planet. A valid signature therefore says only *Google minted this*, which
 * anyone can arrange for themselves in thirty seconds. What makes a token ours is the `aud` claim: Pub/Sub sets
 * it to the audience configured on the push subscription, and that value is the endpoint the token was minted
 * for. Verify the signature and skip the audience and you have built an endpoint that accepts notifications
 * from any Google customer who points a subscription at it.
 *
 * ## Everything above is `@pithy-sh/core/src/http/oidcWebhook`, and none of it is here
 *
 * Algorithm pinning, key resolution by `kid`, signature verification, issuer, audience, `exp`, `nbf`, `iat`,
 * the JWKS fetch and its cache: one implementation, in core, shared with every other OIDC sender the kit
 * verifies. This module is the **Google specialization** — two issuer spellings, a key endpoint, an audience,
 * and the one claim pair Google's own guidance adds — and nothing else. A second copy of a verifier is a
 * second thing to keep current, and the thing that would drift here is an authentication boundary (#520).
 *
 * Core is stricter than the copy it replaced, deliberately: `nbf` is honored, a non-finite skew or key-set
 * lifetime is refused rather than silently disabling the freshness checks, and a claim outside `Date`'s range
 * is quoted as a number rather than throwing a `RangeError` while composing the refusal it had already
 * decided on.
 *
 * ## What a refusal is called
 *
 * Core answers `core/webhook_unverified` for every failing step. The rail re-codes that to
 * **`payments/verification_failed`**, so the audit trail's `metadata.step` stays a `payments/*` value and the
 * webhook guard's pass-through set governs the rest. Core's `detail` rides along under a `Google:` prefix.
 *
 * `payments/invalid_receipt` no longer appears on this path, and that is a deliberate contract change rather
 * than something the refactor dropped. It meant *the token could not be read*, which is a **receipt**
 * distinction: `PaymentsRailProvider.verify` uses it for a client submission, where telling a developer that
 * their payload is malformed is useful. A Pub/Sub push token is not a receipt, it is a webhook credential, and
 * on the webhook path the guard already collapsed both codes to `payments/webhook_unverified` (401) before
 * anything reached the sender — so no caller ever saw the difference, and core's own argument for one code
 * applies with full force: a forger must not learn which check it tripped. Both codes were 400 and
 * `verifyGoogleOidcToken` is not exported from the package, so the change is visible in exactly one place,
 * the audit row's `metadata.step`.
 *
 * Two codes come from core untouched, because neither is a statement about the sender and both are already in
 * the webhook guard's pass-through set: `core/internal` (500) for an endpoint of ours that is not configured
 * to verify anything, and `core/upstream_failed` (502) for Google's key endpoint failing to answer. The
 * second replaces `payments/provider_unavailable` (503) on the JWKS hop alone — CLAUDE.md §Errors gives the
 * upstream pair exactly this job, and the Play Developer API hop is untouched and still 503.
 *
 * **A pass-through code is a code an anonymous caller must not be able to choose**, and that is what decided
 * where the line sits. A published key that is not RSA, or will not import, used to be core's 502 and is
 * core's 401 now: the key was reached because a `kid` in an unverified header selected it, so a 502 there
 * let a forger pick a code this rail passes through — out of the audit trail, and into Pub/Sub's indefinite
 * retry — by naming one `kid` instead of another. Nothing a `kid` can steer stays in the pass-through set.
 * What is left in it is failure nobody chose: the endpoint being unreachable, and our own configuration.
 */

/** Where Google publishes the keys that sign an OIDC token. Public, so it is pinned here rather than stored. */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * The two spellings Google issues an OIDC token under. Both are current, and which one arrives is not ours to
 * decide, so both are accepted and nothing else is.
 */
export const GOOGLE_OIDC_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

/**
 * One published RSA verification key, and the key set Google's endpoint returns.
 *
 * Core's schemas under the rail's published names, not copies of them. The shape is the JWKS shape — it
 * belongs to RFC 7517 rather than to Google — and two declarations of one wire format is the same drift this
 * module exists to remove, one layer down. The names stay because they are `@pithy-sh/payments`' public
 * surface and an adopter typing a Pub/Sub emulator's key against `GoogleJwk` should not have to learn a
 * second one.
 */
export const GoogleJwk = OidcJwk;
export type GoogleJwk = OidcJwk;
export const GoogleJwks = OidcJwks;
export type GoogleJwks = OidcJwks;

/**
 * The claims a Pub/Sub push token carries: core's, plus the two Google adds.
 *
 * `email` and `email_verified` are the extension, and they are the reason this schema exists at all — core
 * reads what every OIDC token has and hands the rest to a predicate. Extended rather than redeclared, so
 * `iss`/`aud`/`exp`/`nbf`/`iat` have one definition in the kit. Still `.loose()`: the whole token is never
 * stored, and a claim set must not be refused for being richer than expected.
 */
export const GoogleOidcClaims = OidcClaims.extend({
  email: z
    .string()
    .min(1)
    .optional()
    .describe("The service account Pub/Sub used to mint the token. Checked against the configured one."),
  email_verified: z
    .boolean()
    .optional()
    .describe("Whether Google vouches for that address. Always true on a real push token."),
}).describe("The claims on a Pub/Sub push OIDC token, narrowed to the ones verification depends on.");
export type GoogleOidcClaims = z.infer<typeof GoogleOidcClaims>;

/** What verifying a push token needs. Everything is explicit, so verification is deterministic in a test. */
export interface VerifyGoogleOidcOptions {
  /** The audience the token must claim — the push subscription's configured audience. The real boundary. */
  audience: string;
  /** The service account the token must have been minted by. Google's own recommended second check. */
  serviceAccountEmail: string;
  /** The clock. Injected so an expiry refusal is deterministic. */
  now: Date;
  /** The HTTP seam Google's key endpoint is reached through. Defaults to the runtime's `fetch`. */
  transport?: GoogleHttpFetch;
  /**
   * Keys accepted **in addition to** Google's published set, matched by `kid`.
   *
   * Additive, so nothing can narrow production's trust: a token whose `kid` these do not cover still resolves
   * against Google. Two callers have a real reason — the tests, which mint their own key so the signature
   * check is exercised for real, and a local Pub/Sub emulator, whose tokens are signed by a key Google never
   * saw.
   */
  trustedKeys?: readonly GoogleJwk[];
  /**
   * Tolerance on `exp`, `nbf` and `iat`, in seconds. Defaults to a minute, and must be a finite number from 0
   * to core's maximum; anything else is `core/internal`, because this is the second operand of all three
   * freshness comparisons and one `NaN` turns them into no-ops together.
   */
  clockSkewSeconds?: number;
  /**
   * How long a fetched key set is held. Defaults to core's hour, and must be a finite number of seconds — a
   * `NaN` is an entry that never expires, which pins a key Google has rotated out.
   */
  jwksTtlSeconds?: number;
  /**
   * Where Google's fetched keys are held between deliveries.
   *
   * **Injected, and there is no default**, which is the point: this used to be a module variable no caller
   * owned, and the only way a test suite could stop inheriting the previous one's keys was an exported
   * `resetGoogleJwksCache` whose sole purpose was to undo it. With no cache the verifier fetches per call,
   * which is correct and slow; a Worker that verifies more than one notification per hour passes a
   * `memoryJwksCache` built once at module scope, or one over KV to share it across isolates.
   *
   * It is two bounds in one object: what Google published, and when Google was last asked. The second is
   * what a token naming a `kid` nobody published runs into, and with no store there is no second bound
   * either — which is why the webhook path is given one and the `verify` path is not.
   */
  jwksCache?: JwksCache;
}

/**
 * Verify one Pub/Sub push OIDC token and return its claims.
 *
 * @throws {@link PaymentsVerificationFailedError} when the sender did not prove itself — an unreadable token,
 *   an unknown key, a key that cannot verify an `RS256` signature, a bad signature, the wrong audience, the
 *   wrong issuer, an expiry, the wrong service account.
 * @throws `core/internal` (500) when this endpoint is not configured to verify anything — an audience that is
 *   empty, a clock that is not a clock, a skew or key-set lifetime that is not a number.
 * @throws `core/upstream_failed` (502) when Google's key endpoint could not be read.
 */
export async function verifyGoogleOidcToken(
  token: string,
  options: VerifyGoogleOidcOptions,
): Promise<GoogleOidcClaims> {
  let verified: OidcClaims;
  try {
    verified = await verifyOidcToken(token, {
      issuers: GOOGLE_OIDC_ISSUERS,
      jwksUrl: GOOGLE_JWKS_URL,
      audience: options.audience,
      claims: (claims) => acceptedByThisEndpoint(claims, options.serviceAccountEmail),
      skewSeconds: options.clockSkewSeconds,
      jwksTtlSeconds: options.jwksTtlSeconds,
      jwksCache: googleKeySource(options.trustedKeys, options.jwksCache),
      transport: options.transport,
      now: options.now,
    });
  } catch (error) {
    throw railCode(error);
  }
  // Core verified and returned the claim set; this is the Google *view* of the same object, and it cannot
  // fail — `acceptedByThisEndpoint` already read both extension fields off it.
  const parsed = GoogleOidcClaims.safeParse(verified);
  if (!parsed.success) {
    throw failed(`the token claims are not those of a Pub/Sub push token — ${issues(parsed.error)}.`);
  }
  return parsed.data;
}

/**
 * Google's own second check, run last and handed only claims core has already proven.
 *
 * It **throws** rather than answering `false`. Core's own refusal for a rejected predicate names the subject
 * and nothing else, which is right for a rule it cannot see inside — and wrong here, where the two things
 * being asserted are named claims and an operator reading the log needs to know which one failed. A predicate
 * that throws a `PaymentsVerificationFailedError` leaves `verifyOidcToken` as itself, past
 * {@link railCode}'s `instanceof`, with the sentence the old verifier wrote.
 *
 * The audience says which endpoint the token was minted for; the email says which identity minted it. Both
 * are always present on a real push token.
 */
function acceptedByThisEndpoint(claims: OidcClaims, serviceAccountEmail: string): true {
  // `.loose()`, so Google's extra claims survive core's parse as `unknown` rather than as strings.
  const email = typeof claims.email === "string" ? claims.email : undefined;
  if (email !== serviceAccountEmail) {
    throw failed(`the token names service account "${snippet(email ?? "none")}", not the configured one.`);
  }
  if (claims.email_verified !== true) {
    throw failed("the token's service-account address is not marked verified by Google.");
  }
  return true;
}

/**
 * The configured keys, presented to core as a key source rather than seeded into its cache.
 *
 * Seeding is the obvious shape and the wrong one, because a cache is **shared** and `trustedKeys` is not. A
 * key written into the store reads back to every other verifier holding that store as a key *Google
 * publishes* — so a Pub/Sub emulator's key, or a suite's, would be trusted by a rail instance nobody handed
 * it to. A wrapper keeps `trustedKeys` additive for its own caller and invisible to everyone else, and it is
 * additive **by construction**: core still fetches for a `kid` the configured keys do not cover, and core's
 * own write-back cannot evict them.
 *
 * No keys and no cache is `undefined`, which is core's "fetch per call" and not a cache that never holds
 * anything.
 *
 * **The refresh claim is delegated, never answered here**, and that is the same rule one axis over: the
 * window belongs to the store, because it is what bounds every caller sharing it. Answering `true` would
 * hand each configured-key caller its own window, which for a store shared across isolates is the bound
 * dissolved by a wrapper nobody thought was one. With no store behind it there is no window to claim and no
 * bound to keep, which is core's own fetch-per-call state.
 */
function googleKeySource(
  trustedKeys: readonly GoogleJwk[] | undefined,
  cache: JwksCache | undefined,
): JwksCache | undefined {
  if (trustedKeys === undefined || trustedKeys.length === 0) return cache;
  return {
    get: async (url) => [...trustedKeys, ...((await cache?.get(url)) ?? [])],
    set: async (url, keys, ttlSeconds) => cache?.set(url, keys, ttlSeconds),
    claimRefresh: async (url, seconds) => (await cache?.claimRefresh(url, seconds)) ?? true,
  };
}

/**
 * Core's refusal under the rail's own code.
 *
 * Only `core/webhook_unverified` is re-coded, and it is re-coded by **class** rather than by reading core's
 * prose — matching on a sentence is the drift this module was written to delete. `core/internal` and
 * `core/upstream_failed` pass through untouched: neither is the sender's failure, both are already in the
 * webhook guard's pass-through set, and re-coding either would name a culprit that is not there.
 */
function railCode(error: unknown): unknown {
  if (!(error instanceof WebhookUnverifiedError)) return error;
  return new PaymentsVerificationFailedError(
    { detail: `Google: ${error.payload.detail ?? "the push token did not verify."}` },
    { cause: error },
  );
}

/** A post-signature refusal. `Google:` prefixed, and the token itself never appears. */
function failed(detail: string): PaymentsVerificationFailedError {
  return new PaymentsVerificationFailedError({ detail: `Google: ${detail}` });
}

/** Zod issues as `path:code` pairs — never `message` or `received`, which would echo the token. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
}

/** How much of a token-supplied value a refusal may quote. Enough to diagnose, too little to fill a log. */
const SNIPPET_LENGTH = 120;

/** A token-supplied value, bounded, so a refusal names what failed without becoming the log. */
function snippet(value: string): string {
  return value.length > SNIPPET_LENGTH ? `${value.slice(0, SNIPPET_LENGTH)}…` : value;
}
