// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { InternalError, UpstreamError, WebhookUnverifiedError } from "../error/pithyError";

/**
 * The `signed-webhook` strategy for a sender that proves itself with an **OIDC token** rather than an HMAC.
 * Issuers, key endpoint, audience and a claims predicate in; the verified claims, or a `PithyError`, out.
 *
 * Two mechanisms, one declared strategy. {@link ./verification.VerificationStrategy} already says as much —
 * *"an HMAC, a signed JWS chain, an OIDC token… a rail whose sender proves it differently implements its
 * own"* — so this sits beside {@link ./signedWebhook.requireSignedWebhook} and wears its seams, rather than
 * adding a word to that union. What changes is where the proof comes from: with an HMAC both ends hold a
 * secret, and with OIDC neither end holds anything. The sender asks its identity provider for a token that
 * expires in minutes; the receiver asks the same provider for the public keys that check it.
 *
 * ## The claims check is the boundary, not the signature
 *
 * An identity provider signs tokens for **everybody** with the same handful of keys. GitHub signs one for
 * every repository on the planet; Google signs one for every Pub/Sub push subscription. So a valid signature
 * proves only *that provider minted this*, which any of their users can arrange in under a minute. What makes
 * a token **ours** is what it claims: `aud`, which the sender names when it mints the token and which is the
 * endpoint it was minted for, and whatever the {@link OidcWebhookScheme.claims} predicate asserts on top —
 * `sub === "repo:pithy-sh/pithy:environment:npm-publish"` for a release job, an issuer's service account for
 * a push subscription. Verify the signature, skip those, and the result is an endpoint every user of that
 * provider can post to.
 *
 * That is why `claims` is a **predicate the route holds** rather than a value in configuration. It is the
 * same constraint as a `ValueRotator`: the declaration is the `signed-webhook` tag on the route, and the code
 * that decides who is allowed lives with the route, where it can be read beside the handler it protects.
 *
 * ## Four steps, in this order, and the order is the security property
 *
 * 1. **Pin the algorithm before touching a key.** `alg` arrives in a header nobody has verified yet, so it is
 *    parsed against a literal `RS256` rather than looked up. That is what makes the two published confusions
 *    unreachable — `none`, which asks for the signature to be skipped, and `HS256`, which asks the verifier to
 *    HMAC with the *public* key as if it were a shared secret. Neither survives a literal.
 * 2. **Resolve the key by `kid` from the issuer's published set.** Never from the token, which is why there is
 *    no `jwk`/`x5u` handling here: a token that carries its own key is a token that verifies itself.
 * 3. **Verify the signature over the exact received segments** — `header.claims` as encoded, never a
 *    re-serialization. Key order and whitespace belong to the sender, not to us.
 * 4. **Then read the claims,** and only then. A claim from an unverified token is a claim an attacker wrote,
 *    so a verifier that reads `iss` or `sub` to decide *which key to fetch* has already trusted the forgery it
 *    is about to check. Issuer, audience, expiry, and the caller's predicate are all after the signature.
 *
 * ## What a refusal says
 *
 * `core/webhook_unverified`, 401, one code for every step a sender can fail — unreadable token, unknown key,
 * bad signature, wrong audience, expired, predicate false. The step goes in `detail`, which the HTTP codec
 * strips, so an operator reading a log learns which check refused it and the sender learns only that
 * something did. Values that decide something are named there (`kid`, `iss`, `aud`) because a misconfigured
 * audience is the realistic failure and an operator cannot fix what the log will not name — truncated by
 * {@link snippet}, and never the signature and never the whole token.
 *
 * Two failures are deliberately **not** the sender's. An endpoint with no issuers, no audience, no key
 * endpoint, or a clock that is not a clock is a configuration fault and takes `core/internal` — reporting it
 * as an unverified webhook sends an operator hunting a forger who is not there. And a key endpoint that
 * cannot be reached or answers nonsense is `core/upstream_failed` (502), because a 500 tells an operator to
 * read *our* logs and the thing that broke is the issuer's. Both still refuse the delivery: fail closed is
 * about what happens to the request, not about whose code goes on it.
 *
 * ## What this proves, and what it does not
 *
 * The same caveat as the HMAC scheme, for the same reason: this proves a delivery is authentic and fresh,
 * never that it is *new*. A captured token replays until it expires. A handler that grants, charges, or
 * deletes needs its own uniqueness key.
 */

/** How long a fetched key set is reused. Issuers rotate slowly, and an unknown `kid` forces a refresh anyway. */
export const OIDC_JWKS_TTL_SECONDS = 3600;

/** Tolerance on `exp`, `nbf` and `iat`. A minute covers clock drift; an hour would cover a replay. */
export const OIDC_CLOCK_SKEW_SECONDS = 60;

/**
 * The most tolerance this verifier accepts, and it refuses above rather than clamping.
 *
 * A skew is a replay window in the plainest possible units: every second of it is a second longer a captured
 * token keeps working. Five minutes is the far end of real drift between two machines that both run NTP; past
 * that a number has stopped covering drift and started covering a capture, which is what the sentence above
 * says about an hour. Refused rather than clamped because a `604800` is a typo or a misunderstanding either
 * way — clamped, it boots and nobody reads the line again; refused, it is a red boot and a two-character fix.
 */
export const OIDC_MAX_CLOCK_SKEW_SECONDS = 300;

/** The header a bearer token arrives in, unless a sender names another. Lower case, as Hono presents one. */
const DEFAULT_TOKEN_HEADER = "authorization";

/** RSASSA-PKCS1-v1_5 with SHA-256 — the one algorithm `alg: RS256` names, fixed here rather than derived. */
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** The unpadded url alphabet (RFC 4648 §5). Whitespace, `+`, `/` and `=` are all outside it, deliberately. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** How much of a token-supplied value a refusal may quote. Enough to diagnose, too little to fill a log. */
const SNIPPET_LENGTH = 120;

/**
 * The header of an OIDC token, as tightly as it can be stated. `alg` is a literal for the reason in the
 * module doc; `kid` is required because a key is resolved by it and a token that names no key cannot be
 * checked against one. `.loose()` because a provider may add a field and a real token must not be refused
 * for carrying something new.
 */
const OidcTokenHeader = z
  .object({
    alg: z
      .literal("RS256")
      .describe(
        "The signing algorithm. A literal, not a lookup: `alg` arrives in an unverified header, and accepting `none` or `HS256` from it is how JWS verifiers are bypassed.",
      ),
    kid: z
      .string()
      .min(1)
      .describe("Which of the issuer's published keys signed the token. Resolved against the issuer's key set."),
  })
  .loose()
  .describe("The header of an OIDC token, constrained to the one shape this verifier accepts.");

/**
 * One published RSA verification key, in the shape a JWKS endpoint returns. `.loose()` because providers add
 * fields, and a key set must not be rejected for carrying something this build does not read.
 */
export const OidcJwk = z
  .object({
    kid: z.string().min(1).describe("The key id a token header names."),
    kty: z.string().min(1).describe("The key type. Only `RSA` is accepted — an OIDC token is signed with one."),
    n: z.string().min(1).describe("The RSA modulus, base64url."),
    e: z.string().min(1).describe("The RSA public exponent, base64url."),
    alg: z.string().min(1).optional().describe("The algorithm the key is published for, when stated."),
    use: z.string().min(1).optional().describe("What the key is published for — `sig` for a signing key."),
  })
  .loose()
  .describe("One published OIDC verification key, as a JWKS endpoint returns it.");
export type OidcJwk = z.infer<typeof OidcJwk>;

/** A published key set. At least one key: an empty set is an endpoint that is not answering properly. */
export const OidcJwks = z
  .object({
    keys: z.array(OidcJwk).min(1).describe("Every key the issuer currently publishes for signature verification."),
  })
  .loose()
  .describe("The response of an issuer's JWKS endpoint.");
export type OidcJwks = z.infer<typeof OidcJwks>;

/**
 * The claims an OIDC token carries, narrowed to the ones that decide anything. `.loose()` keeps the rest —
 * the predicate reads them, and a claim set must not be refused for being richer than expected.
 *
 * `aud` is a **string and only a string**, though RFC 7519 permits an array. The audience check is the
 * boundary, and an array turns an equality into a set membership — one more shape for a verifier to be wrong
 * about, on the check the whole scheme rests on. No sender the kit talks to mints one.
 */
export const OidcClaims = z
  .object({
    iss: z.string().min(1).describe("Who issued the token. Checked against the configured issuers, and nothing else."),
    aud: z
      .string()
      .min(1)
      .describe(
        "Who the token was minted for — the endpoint the sender named when it asked for the token. The claim that makes a token ours rather than merely the issuer's.",
      ),
    sub: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Which identity the issuer minted the token for — a workflow's `repo:owner/name:environment:x`, a service account. Read by the caller's `claims` predicate, never by this module.",
      ),
    exp: z.number().int().describe("When the token expires, in seconds since the epoch."),
    nbf: z.number().int().optional().describe("The earliest the token may be used, in seconds since the epoch."),
    iat: z.number().int().optional().describe("When the token was issued, in seconds since the epoch."),
  })
  .loose()
  .describe("The claims on an OIDC token, narrowed to the ones verification depends on.");
export type OidcClaims = z.infer<typeof OidcClaims>;

/** The response shape this module reads. Structural, so a test's transport need not be a whole `Response`. */
export interface OidcJwksResponse {
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The status code, which is what decides the mapping. */
  status: number;
  /** The body as text. Read as text rather than JSON so a non-JSON answer is a diagnosis, not a throw. */
  text(): Promise<string>;
}

/**
 * The HTTP seam the key endpoint is reached through.
 *
 * Injectable for exactly one reason: **no test may reach a live identity provider**, and a verifier whose
 * network call could not be substituted would have to be tested through a stub of itself, which proves
 * nothing. One explicit parameter rather than a reassigned global — a global stub leaks between suites and
 * hides which module was actually exercised.
 */
export type OidcJwksFetch = (url: string) => Promise<OidcJwksResponse>;

/** The default transport: the runtime's own `fetch`. */
export const oidcJwksFetch: OidcJwksFetch = (url) => fetch(url) as unknown as Promise<OidcJwksResponse>;

/**
 * Where a fetched key set is held between requests.
 *
 * **Injected, never a module global.** A cache in a module variable is one cache for the whole isolate that
 * no caller owns, which is how `resetGoogleJwksCache` came to exist: once the state is unreachable, a test
 * suite needs an exported function whose only purpose is to undo the previous suite. Passing the store in
 * deletes that function and the class of bug it papers over — a test seeds its own, and a Worker gives one
 * over KV or the Cache API and shares it across isolates.
 *
 * **Owning the store is not the same as having none.** {@link requireOidcWebhook} builds one per guard when a
 * route gives none, because the guard is the surface anonymous traffic arrives on: with no cache, a 49-byte
 * forged token naming a published `kid` buys a round trip to the issuer, 1:1, until the issuer rate-limits us
 * and the real deliveries 502 alongside the forgeries. {@link verifyOidcToken} called directly is the other
 * case and does fetch per call — its caller holds one token it has already decided to check, so there is no
 * flood to absorb and no cache to acquire by surprise.
 *
 * Public keys, so nothing here is what CLAUDE.md's secrets rule governs: the whole point of a JWKS endpoint
 * is that anyone may read it. What the cache buys is one round trip per TTL instead of one per delivery.
 */
export interface JwksCache {
  /** The key set held for `url`, or `undefined` when nothing usable is held. */
  get(url: string): Promise<readonly OidcJwk[] | undefined>;
  /** Hold a freshly fetched key set for `url` for `ttlSeconds`. */
  set(url: string, keys: readonly OidcJwk[], ttlSeconds: number): Promise<void>;
}

/**
 * A key cache in memory, expiring on a clock the caller owns.
 *
 * One object per call, so two callers never share one by accident and a test's cache dies with its test. The
 * clock is injected for the same reason it is everywhere else here: an expiry that depends on wall time is an
 * assertion nobody can write.
 */
export function memoryJwksCache(options: { now?: () => Date } = {}): JwksCache {
  const now = options.now ?? (() => new Date());
  const held = new Map<string, { keys: readonly OidcJwk[]; expiresAt: number }>();
  return {
    get: async (url) => {
      const entry = held.get(url);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now().getTime()) {
        held.delete(url);
        return undefined;
      }
      return entry.keys;
    },
    set: async (url, keys, ttlSeconds) => {
      held.set(url, { keys, expiresAt: now().getTime() + ttlSeconds * 1000 });
    },
  };
}

/** What the two ends of the scheme must agree on, and what the receiver decides for itself. */
export interface OidcWebhookScheme {
  /**
   * The `iss` values this endpoint accepts. More than one only where a provider publishes more than one
   * spelling of itself — Google issues under both `accounts.google.com` and `https://accounts.google.com`;
   * GitHub uses one. Empty is a configuration fault, never "accept anything".
   */
  issuers: readonly string[];
  /** Where the issuer publishes the keys that sign its tokens. Public, so it is configuration and not a secret. */
  jwksUrl: string;
  /** The `aud` the token must claim — the value the sender named when it minted one. The real boundary. */
  audience: string;
  /**
   * Whatever else makes a token *this endpoint's*: `(claims) => claims.sub === "repo:owner/name:environment:x"`.
   *
   * A predicate rather than configuration, because it cannot cross into `pithy.manifest.json` and should not
   * try: the manifest declares the strategy, the route holds the rule. Run **last**, after the signature and
   * every standard claim, so it is only ever handed claims that are already proven to be the issuer's.
   */
  claims: (claims: OidcClaims) => boolean | Promise<boolean>;
  /**
   * Tolerance on `exp`, `nbf` and `iat`, in seconds. Defaults to {@link OIDC_CLOCK_SKEW_SECONDS} and must be
   * a finite number from 0 to {@link OIDC_MAX_CLOCK_SKEW_SECONDS}; anything else is `core/internal`, because
   * this is the second operand of all three freshness comparisons and one `NaN` disables them together.
   */
  skewSeconds?: number;
  /**
   * How long a fetched key set is held. Defaults to {@link OIDC_JWKS_TTL_SECONDS} and must be a finite number
   * of seconds — a `NaN` is an entry that never expires, which pins a key the issuer has rotated out.
   */
  jwksTtlSeconds?: number;
  /**
   * Where fetched keys are held between deliveries. Never a module global: {@link requireOidcWebhook} builds
   * one per guard when a route gives none, and {@link verifyOidcToken} called directly fetches per call.
   */
  jwksCache?: JwksCache;
  /** The HTTP seam the key endpoint is reached through. Defaults to the runtime's `fetch`. */
  transport?: OidcJwksFetch;
}

/** Everything {@link verifyOidcToken} needs beyond the token itself. */
export interface VerifyOidcTokenOptions extends OidcWebhookScheme {
  /** The clock. Injectable so an expiry refusal is deterministic rather than wall-clock dependent. */
  now?: Date;
}

/** Everything {@link requireOidcWebhook} needs, as a route wears it. */
export interface OidcWebhookGuardOptions extends OidcWebhookScheme {
  /** The header the token arrives in, lower case. Defaults to `authorization`, carrying `Bearer <token>`. */
  header?: string;
  /** The clock, for the freshness checks. A function because a guard is built once and used per request. */
  now?: () => Date;
}

/**
 * Verify one OIDC token and return its claims. Throws, never reports.
 *
 * The steps run in the order the module doc gives, and that order **is** the security property: algorithm
 * pinned, key resolved by `kid` from the published set, signature checked over the received bytes, and only
 * then a single claim read. A verifier that reads a claim to decide which key to fetch has trusted the thing
 * it has not checked yet.
 *
 * @throws {@link WebhookUnverifiedError} (401) when the sender did not prove itself — unreadable token,
 *   unknown key, bad signature, wrong issuer or audience, expired, not yet valid, predicate false.
 * @throws {@link InternalError} (500) when this endpoint is not configured to verify anything.
 * @throws {@link UpstreamError} (502) when the issuer's key endpoint could not be read.
 */
export async function verifyOidcToken(token: string, options: VerifyOidcTokenOptions): Promise<OidcClaims> {
  // Ours before theirs. An endpoint with nothing to check against refuses every delivery, and calling that an
  // unverified webhook would send an operator after a forger while the real answer is an empty config value.
  const issuers = options.issuers.filter((issuer) => issuer.length > 0);
  if (issuers.length === 0 || options.audience.length === 0 || options.jwksUrl.length === 0) {
    throw misconfigured(
      "Give the OIDC webhook guard an issuer, an audience, and a JWKS URL.",
      "The OIDC webhook guard resolved no issuer, no audience, or no key endpoint, so it can verify nothing.",
    );
  }
  const seconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // Fail closed on a clock that is not one. Every comparison below is `>` or `<` against this number, and
  // NaN answers false to both — an invalid Date would wave every expired token through, in the one function
  // whose whole argument is that it fails closed. Only a caller-supplied `now` can reach here as NaN, so it
  // is our fault and takes our code, like the configuration above.
  if (!Number.isFinite(seconds)) {
    throw misconfigured(
      "Give the OIDC webhook guard a valid clock.",
      "The OIDC webhook guard was handed a clock that is not a valid Date, so no token's freshness can be judged.",
    );
  }
  // The *other* operand of every one of those comparisons, and unguarded it fails open in exactly the same
  // way — worse, because `exp + NaN < seconds` is false for a token that expired a second ago and for one
  // that expired last year alike, so one unchecked number turns `exp`, `nbf` and `iat` into no-ops together.
  // The realistic source is a route reading `Number(env.OIDC_SKEW_SECONDS)` for a variable nobody set:
  // TypeScript types that `number` and nothing downstream looks again. Guarding one side of a comparison and
  // not the other is not a guard. The upper bound is the same argument as the constant it defaults to — a
  // tolerance is a replay window, so it is configuration that has to be small, not merely present.
  const skew = options.skewSeconds ?? OIDC_CLOCK_SKEW_SECONDS;
  if (!Number.isFinite(skew) || skew < 0 || skew > OIDC_MAX_CLOCK_SKEW_SECONDS) {
    throw misconfigured(
      `Give the OIDC webhook guard a clock skew between 0 and ${OIDC_MAX_CLOCK_SKEW_SECONDS} seconds.`,
      `The OIDC webhook guard was given a clock skew of ${String(skew)} seconds, and a tolerance must be a number from 0 to ${OIDC_MAX_CLOCK_SKEW_SECONDS}.`,
    );
  }
  // The same class again, one field over: a non-finite lifetime makes a cached entry expire at NaN, and
  // `NaN <= now` is false forever — so a key set the issuer has since rotated out stays trusted for the life
  // of the isolate. A cache that never expires is not a fast cache, it is a key pin nobody chose.
  const jwksTtlSeconds = options.jwksTtlSeconds ?? OIDC_JWKS_TTL_SECONDS;
  if (!Number.isFinite(jwksTtlSeconds) || jwksTtlSeconds < 0) {
    throw misconfigured(
      "Give the OIDC webhook guard a key-set lifetime of zero seconds or more.",
      `The OIDC webhook guard was given a key-set lifetime of ${String(jwksTtlSeconds)} seconds, which would never expire.`,
    );
  }

  const { head, body, mac } = splitCompactJws(token);

  const header = OidcTokenHeader.safeParse(decodeJwtJson(head, "the token header"));
  if (!header.success) {
    throw unverified(`the token header is not one this endpoint accepts — ${issues(header.error)}.`);
  }

  const key = await importKey(await resolveKey(header.data.kid, options));
  const verified = await crypto.subtle.verify(
    RS256.name,
    key,
    // Copied, not passed through. `crypto.subtle.verify` takes a `BufferSource`, and a view onto a
    // `SharedArrayBuffer` is bytes another thread can still be writing while the comparison runs.
    new Uint8Array(decodeBase64Url(mac, "the token signature")) as unknown as ArrayBuffer,
    new TextEncoder().encode(`${head}.${body}`) as unknown as ArrayBuffer,
  );
  if (!verified) {
    throw unverified(`the token signature does not match the signed segments under key ${snippet(header.data.kid)}.`);
  }

  // Only now. Everything above proves the issuer minted this token; everything below proves it was minted
  // for us. A claim read before this line is a claim whoever sent the request chose.
  const parsed = OidcClaims.safeParse(decodeJwtJson(body, "the token claims"));
  if (!parsed.success) {
    throw unverified(`the token claims are not those of an OIDC token — ${issues(parsed.error)}.`);
  }
  const claims = parsed.data;

  if (!issuers.includes(claims.iss)) {
    throw unverified(`the token issuer is ${snippet(claims.iss)}, which this endpoint does not accept.`);
  }
  // The boundary. Everything above proves the issuer signed it; this is what proves it was minted for us and
  // not for another of that issuer's users — or for this project's other environment.
  if (claims.aud !== options.audience) {
    throw unverified(
      `the token audience is ${snippet(claims.aud)}, and this endpoint expects ${snippet(options.audience)}.`,
    );
  }
  if (claims.exp + skew < seconds) {
    throw unverified(`the token expired at ${instant(claims.exp)}.`);
  }
  if (claims.nbf !== undefined && claims.nbf - skew > seconds) {
    throw unverified(`the token is not valid before ${instant(claims.nbf)}.`);
  }
  if (claims.iat !== undefined && claims.iat - skew > seconds) {
    throw unverified(`the token was issued at ${instant(claims.iat)}, which is in the future.`);
  }

  // Last, and handed only proven claims. This is where a route says who it accepts, so a false answer here is
  // "the issuer minted this for somebody else", which is a different sentence from "this is not signed".
  if (!(await options.claims(claims))) {
    throw unverified(
      `the token is the issuer's but its claims are not accepted by this endpoint — subject ${snippet(claims.sub ?? "none")}.`,
    );
  }

  return claims;
}

/**
 * The OIDC gate, as a route wears it: `app.post(path, requireOidcWebhook({…}), zValidator("json", Body,
 * validationHook), handler)`.
 *
 * ## Why the header is read before anything else
 *
 * The bearer header is the cheapest thing to check and the commonest thing to be missing, so it goes first. A
 * delivery carrying no token is refused whatever the body holds, and fetching a key set before looking would
 * be unauthenticated work an anonymous POST could buy on the one route whose purpose is to refuse anonymous
 * callers.
 *
 * ## Why a cache is not optional here
 *
 * A caller that presents *something* is past that first check, and the next thing the verifier needs is the
 * issuer's key set. So the guard builds a {@link memoryJwksCache} when the route gives none — once, when the
 * middleware is constructed, never per request, which is a cache that has never held anything. A `kid` is
 * published by definition, which makes a 49-byte token naming one the cheapest thing on the internet to send,
 * and with no cache each one is a round trip to the issuer, 1:1. That is a bandwidth multiplier aimed at
 * somebody else's endpoint, and once the issuer rate-limits us {@link fetchJwks} maps it to
 * `core/upstream_failed` for the genuine deliveries too — an anonymous caller taking the boundary down by
 * asking it politely. A route wanting a harder bound (shared across isolates, or rate-limiting) passes its
 * own {@link OidcWebhookScheme.jwksCache}, and this one is never built.
 *
 * A `kid` **nobody** publishes still costs one fetch per delivery, cache or no cache, because an unknown key
 * id is how rotation announces itself and declining to look is an outage. That bound is per delivery and
 * lives in {@link resolveKey}; the cache is what collapses the other flood, the one naming a key that exists.
 *
 * ## Why nothing is published to the request
 *
 * The gate proves the caller and returns; it sets no request variable. The claims a route cares about are the
 * ones its own {@link OidcWebhookScheme.claims} predicate already asserted, and a handler that needs the
 * whole claim set calls {@link verifyOidcToken} directly rather than reading a variable it must remember to
 * null-check.
 *
 * The body is never read here — unlike the HMAC gate, whose proof covers the bytes. An OIDC token proves who
 * sent the request and says nothing about what they sent, so the route's `zValidator` is the only thing that
 * touches the body, and it sees an untouched stream.
 */
export function requireOidcWebhook(options: OidcWebhookGuardOptions): MiddlewareHandler<PithyHonoEnv> {
  const { header = DEFAULT_TOKEN_HEADER, now, ...scheme } = options;
  // Built with the guard and shared by every delivery it sees. On the guard's own clock, so a suite that
  // injects one governs the expiry too rather than reaching wall time through the back door.
  const jwksCache = scheme.jwksCache ?? memoryJwksCache({ now });
  return async (c, next) => {
    // The cheapest possible rejection, ahead of every cost an anonymous caller could otherwise buy.
    const presented = c.req.header(header);
    const token = presented === undefined ? undefined : bearerToken(presented);
    if (token === undefined) {
      throw unverified(`the delivery carries no ${header} header with a Bearer token.`);
    }

    await verifyOidcToken(token, { ...scheme, jwksCache, now: now?.() ?? new Date() });

    await next();
  };
}

/**
 * The key a token's `kid` names, from the cache when it holds it and from the issuer otherwise.
 *
 * A `kid` the cache does not hold triggers **exactly one** refresh, which is what makes key rotation
 * invisible: a new signing key appears in a token before anything tells us to look for it, and waiting out a
 * TTL would be an outage. Exactly one, because otherwise a stream of forged tokens naming random `kid`s is a
 * way to make us hammer the issuer — one delivery buys one fetch, whatever it claims. A caller that wants a
 * harder bound than that gives a {@link JwksCache} that rate-limits, which is the other thing injecting the
 * store buys.
 */
async function resolveKey(kid: string, options: VerifyOidcTokenOptions): Promise<OidcJwk> {
  const held = await options.jwksCache?.get(options.jwksUrl);
  const cached = held?.find((key) => key.kid === kid);
  if (cached) return cached;

  const refreshed = await fetchJwks(options);
  await options.jwksCache?.set(options.jwksUrl, refreshed, options.jwksTtlSeconds ?? OIDC_JWKS_TTL_SECONDS);
  const found = refreshed.find((key) => key.kid === kid);
  if (!found) {
    throw unverified(`no key the issuer publishes matches the token's kid ${snippet(kid)}.`);
  }
  return found;
}

/**
 * Fetch and validate the issuer's key set.
 *
 * Every failure is `core/upstream_failed`, and every failure still refuses the delivery. The code says whose
 * system to look at — a 500 would send an operator into our logs for an outage at an endpoint we do not run,
 * and a 401 would send them after a forger. The URL is named because it is our own configuration, not
 * anything a caller supplied.
 */
async function fetchJwks(options: VerifyOidcTokenOptions): Promise<OidcJwk[]> {
  const transport = options.transport ?? oidcJwksFetch;
  let response: OidcJwksResponse;
  try {
    response = await transport(options.jwksUrl);
  } catch (cause) {
    throw upstream(`The OIDC key endpoint ${options.jwksUrl} did not answer.`, cause);
  }
  if (!response.ok) {
    throw upstream(`The OIDC key endpoint ${options.jwksUrl} answered ${response.status}.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text()) as unknown;
  } catch (cause) {
    // An HTML error page behind a proxy is the realistic shape of this, and reading it as an empty key set
    // would refuse every delivery with a sentence about the sender's `kid`.
    throw upstream(`The OIDC key endpoint ${options.jwksUrl} answered a non-JSON body.`, cause);
  }

  const parsed = OidcJwks.safeParse(body);
  if (!parsed.success) {
    throw upstream(`The OIDC key endpoint ${options.jwksUrl} answered an unexpected shape — ${issues(parsed.error)}.`);
  }
  return parsed.data.keys;
}

/** Import one published JWK as a verification key. A non-RSA key is refused rather than handed to WebCrypto. */
async function importKey(jwk: OidcJwk): Promise<CryptoKey> {
  if (jwk.kty !== "RSA") {
    throw upstream(`Published key ${snippet(jwk.kid)} is ${snippet(jwk.kty)}, and only RSA keys sign an OIDC token.`);
  }
  try {
    // `alg` is forced to `RS256` rather than taken from the published key: the algorithm is already pinned by
    // the header literal, and a key set that published a different one would otherwise decide it for us.
    return await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256" }, RS256, false, ["verify"]);
  } catch (cause) {
    throw upstream(`Published key ${snippet(jwk.kid)} could not be imported.`, cause);
  }
}

/**
 * Split a compact JWS, refusing anything that is not three non-empty segments.
 *
 * The empty-segment check is the structural half of the algorithm pin: `alg: none` produces a header, a
 * payload, and nothing after the final dot, so it is refused here before a header is even decoded.
 */
function splitCompactJws(token: string): { head: string; body: string; mac: string } {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw unverified(`the token has ${segments.length} segments, expected 3.`);
  }
  const [head, body, mac] = segments as [string, string, string];
  if (head.length === 0 || body.length === 0 || mac.length === 0) {
    throw unverified("a token segment is empty; an unsigned token is not accepted.");
  }
  return { head, body, mac };
}

/**
 * Bytes from one unpadded base64url segment (RFC 4648 §5), strictly.
 *
 * A token segment is attacker-supplied by definition and `atob` is famously forgiving — it digests whitespace
 * and, on some runtimes, characters that mean nothing. Silently decoding malformed input produces bytes that
 * parse into *something*, and something is exactly what a forger wants a verifier to work with. Padding is
 * refused too: RFC 7515 §2 mandates unpadded segments, and one token with two spellings is one more thing a
 * comparison can be wrong about.
 */
function decodeBase64Url(value: string, label: string): Uint8Array {
  // A base64 group is 2, 3 or 4 characters. One leftover character encodes no byte at all, so a length of
  // 1 mod 4 is unrepresentable rather than merely odd — refuse it before `atob` guesses.
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw unverified(`${label} is not unpadded base64url.`);
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw unverified(`${label} failed base64url decode.`, cause);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** One base64url JSON segment. `unknown` out — decoded bytes are not yet a known shape. */
function decodeJwtJson(segment: string, label: string): unknown {
  const text = new TextDecoder().decode(decodeBase64Url(segment, label));
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // Never echo the text. It is attacker-supplied on every request, and `detail` reaches an operator's logs.
    throw unverified(`${label} is not JSON.`, cause);
  }
}

/** Read `Bearer <token>` from a header value, or `undefined` when it is not one. The scheme is case-insensitive. */
function bearerToken(value: string): string | undefined {
  const match = /^bearer +(\S+)$/i.exec(value.trim());
  return match?.[1];
}

/** The sender's refusal. One code for every step; the step is in `detail`, which never reaches the sender. */
function unverified(detail: string, cause?: unknown): WebhookUnverifiedError {
  return new WebhookUnverifiedError(
    {
      action: "Send a current OIDC token minted for this endpoint's audience.",
      detail: `The OIDC webhook guard refused a delivery: ${detail}`,
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Ours, not the sender's. Every value this refuses on is one *we* wrote — an issuer list, an audience, a
 * clock, a tolerance — so it takes `core/internal` and an `action` naming the knob to turn, rather than
 * sending an operator after a forger who is not there. Still a refusal: the delivery is denied either way.
 */
function misconfigured(action: string, detail: string): InternalError {
  return new InternalError({ message: "This webhook endpoint is not configured.", action, detail });
}

/** The issuer's failure, not the sender's and not ours. Still a refusal — 502 denies the delivery. */
function upstream(detail: string, cause?: unknown): UpstreamError {
  return new UpstreamError(
    { action: "Check that this Worker can reach the issuer's JWKS endpoint.", detail },
    cause === undefined ? undefined : { cause },
  );
}

/** Zod issues as `path:code` pairs — never `message` or `received`, which would echo the token. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`).join(", ");
}

/**
 * One epoch-seconds claim, rendered for a refusal.
 *
 * The comparisons above are arithmetic and are right for any number `z.number().int()` admits — but
 * `toISOString()` is not: `new Date(-1e15 * 1000)` is an invalid Date and **throws a `RangeError`**, which is
 * a plain `Error` escaping a module whose every other exit is a `PithyError`. It is thrown while composing
 * the *refusal message* for a token that has already been decided against, so the token is still refused —
 * but through {@link requireOidcWebhook} the sender chooses whether they get a 401 or a 500, and a 500 sends
 * an operator into our logs over somebody else's forgery. So a claim outside `Date`'s range is quoted as the
 * number it is, and the refusal stays the refusal it already was.
 */
function instant(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  return Number.isFinite(at.getTime()) ? at.toISOString() : `epoch second ${epochSeconds}`;
}

/** A token-supplied value, quoted and bounded, so a refusal names what failed without becoming the log. */
function snippet(value: string): string {
  const trimmed = value.length > SNIPPET_LENGTH ? `${value.slice(0, SNIPPET_LENGTH)}…` : value;
  return JSON.stringify(trimmed);
}
