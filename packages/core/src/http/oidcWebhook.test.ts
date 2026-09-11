// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { PithyHonoEnv } from "../capability/capability";
import { pithyErrorHandler } from "../error/http";
import { InternalError, PithyError, UpstreamError, WebhookUnverifiedError } from "../error/pithyError";
import { base64Url, type MintedKey, mintKey, publishing, signToken } from "../test-utils/oidcFixtures";
import {
  memoryJwksCache,
  OIDC_JWKS_MIN_REFRESH_SECONDS,
  OIDC_JWKS_TTL_SECONDS,
  OIDC_MAX_CLOCK_SKEW_SECONDS,
  type OidcClaims,
  type OidcJwk,
  type OidcJwksFetch,
  requireOidcWebhook,
  verifyOidcToken,
} from "./oidcWebhook";
import { validationHook } from "./validation";

/**
 * The authenticity boundary on an OIDC webhook, exercised for real: minted RSA keys, genuine RS256
 * signatures, and a verifier given only what it should trust.
 *
 * **Every negative case below is a token the issuer really signed**, or one signed by a second real key —
 * never a stub told to refuse. That is the only way a signature test can fail for the right reason. The one
 * thing no test does is reach the network: the JWKS transport is injected in every call, and the suite's
 * `transport` records what it was asked for, so a fetch nobody expected shows up as a count.
 *
 * **The claims are the boundary, not the signature.** Every token in the `refuses` cases verifies
 * cryptographically. What separates ours from anyone else's is `aud` and the `claims` predicate — which is
 * exactly why those two cases matter more than the signature ones.
 *
 * **The issuer's side comes from `../test-utils/oidcFixtures`, which adopters import too.** It used to be
 * private here, so the first project mounting `requireOidcWebhook` re-derived 103 lines of it and got the
 * wire format wrong — a transport answering `json()` where the seam declares `text()`. This suite is that
 * module's first consumer rather than a copy of it, which is the only thing that keeps a shipped fixture
 * honest: the helpers a customer's route is proved with are the helpers the verifier is proved with.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const AUDIENCE = "https://dashboard.pithy.sh/api/release-records";
const SUBJECT = "repo:pithy-sh/pithy:environment:npm-publish";
const NOW = new Date("2026-09-09T12:00:00.000Z");

/** Seconds since the epoch, the unit every claim below is written in. */
const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** Key generation is the slow part and a key is immutable — one for the suite, plus one impostor. */
let key: MintedKey;
let impostor: MintedKey;

beforeAll(async () => {
  key = await mintKey("pithy-test-1");
  impostor = await mintKey("impostor-1");
});

/** The claims GitHub puts on a release job's token, all valid. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    exp: epochSeconds(NOW) + 300,
    nbf: epochSeconds(NOW) - 60,
    iat: epochSeconds(NOW) - 60,
    repository: "pithy-sh/pithy",
    ...overrides,
  };
}

/** The verifier under the suite's defaults: this issuer, this audience, this subject, the suite's key. */
function verify(token: string, overrides: Record<string, unknown> = {}) {
  return verifyOidcToken(token, {
    issuers: [ISSUER],
    jwksUrl: JWKS_URL,
    audience: AUDIENCE,
    claims: (c) => c.sub === SUBJECT,
    now: NOW,
    transport: publishing(JWKS_URL, [key.jwk]),
    ...overrides,
  });
}

/**
 * The cheapest forgery there is: a token signed by a key nobody publishes, naming a `kid` nobody has ever
 * published either. A new `kid` per call, because `kid` is read out of an unverified header — an attacker
 * picks one per delivery for nothing, and that is the traffic the refresh window exists to bound.
 */
function forgedToken(): Promise<string> {
  return signToken(claims(), impostor, { kid: `forged-${crypto.randomUUID()}` });
}

describe("verifyOidcToken accepts", () => {
  test("a token the issuer signed for this endpoint, and hands back its claims", async () => {
    const verified = await verify(await signToken(claims(), key));
    expect(verified.iss).toBe(ISSUER);
    expect(verified.aud).toBe(AUDIENCE);
    expect(verified.sub).toBe(SUBJECT);
    // `.loose()`, so a claim this module never reads still reaches the predicate and the caller.
    expect(verified.repository).toBe("pithy-sh/pithy");
  });

  test("one of several configured issuer spellings", async () => {
    // Google publishes under two spellings of itself and which arrives is not ours to decide; GitHub uses
    // one. The list is what makes both providers one verifier.
    await expect(
      verify(await signToken(claims({ iss: "accounts.google.com" }), key), {
        issuers: [ISSUER, "accounts.google.com"],
      }),
    ).resolves.toBeDefined();
  });

  test("a token seconds past expiry, which is clock drift rather than a replay", async () => {
    const claimed = claims({ exp: epochSeconds(NOW) - 30 });
    await expect(verify(await signToken(claimed, key))).resolves.toBeDefined();
  });

  test("a token with no nbf and no iat — both are optional, and only exp is mandatory", async () => {
    const claimed = claims({ nbf: undefined, iat: undefined });
    await expect(verify(await signToken(claimed, key))).resolves.toBeDefined();
  });

  test("a wider skew than the default, up to the cap, and the same token without it does not pass", async () => {
    // Both halves, because either alone proves nothing: the first says the option is read at all, the
    // second says the default is what refuses this token, so a verifier that ignored `skewSeconds`
    // entirely — or one that took the default for everything — fails one of them.
    const claimed = claims({ exp: epochSeconds(NOW) - 90 });
    await expect(verify(await signToken(claimed, key), { skewSeconds: 120 })).resolves.toBeDefined();
    expect(await refusal(verify(await signToken(claimed, key)))).toBeInstanceOf(WebhookUnverifiedError);
  });
});

describe("verifyOidcToken refuses", () => {
  test("a token minted for another audience, however well signed", async () => {
    // The case the whole check exists for: same issuer, same key, valid signature, valid dates — and a token
    // the issuer minted for somebody else's endpoint. Or for this project's *other* environment, which is why
    // staging and prod do not share one.
    const thrown = await refusal(verify(await signToken(claims({ aud: "https://staging.pithy.sh/api" }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("audience");
  });

  test("an audience that merely contains the configured one, in any of its near spellings", async () => {
    // The equality is the boundary, and an equality is the comparison with near-misses on every side. Each
    // of these is an `aud` any user of this issuer can ask for by name: a suffix on ours, ours carried in
    // somebody else's query string, and ours in another case. So `startsWith`, `includes` or a
    // case-insensitive compare where `!==` stands is not a laxness, it is a forgery that verifies — and the
    // two audience cases above refuse under all four, which is why the shape needs pinning here.
    for (const aud of [
      `${AUDIENCE}.attacker.example`,
      `https://evil.example/?redirect=${AUDIENCE}`,
      AUDIENCE.toUpperCase(),
    ]) {
      const thrown = await refusal(verify(await signToken(claims({ aud }), key)));
      expect(thrown, aud).toBeInstanceOf(WebhookUnverifiedError);
      expect(thrown.payload.detail, aud).toContain("audience");
    }
  });

  test("a token from an issuer this endpoint does not accept", async () => {
    const thrown = await refusal(
      verify(await signToken(claims({ iss: "https://token.actions.githubusercontent.com.evil.example" }), key)),
    );
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("issuer");
  });

  test("an expired token", async () => {
    const thrown = await refusal(verify(await signToken(claims({ exp: epochSeconds(NOW) - 3600 }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("expired");
  });

  test("a token that is not valid yet", async () => {
    // `nbf` is honored though the verifier this generalizes does not read it: a token the issuer says is not
    // usable yet is not a token to act on, and it costs one comparison to say so.
    const thrown = await refusal(verify(await signToken(claims({ nbf: epochSeconds(NOW) + 3600 }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("not valid before");
  });

  test("a token issued in the future beyond the skew", async () => {
    const thrown = await refusal(verify(await signToken(claims({ iat: epochSeconds(NOW) + 3600 }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("issued");
  });

  test("a token signed by a key the issuer does not publish", async () => {
    // The impostor's `kid` is nowhere in the published set, so the lookup fails before any signature work.
    const thrown = await refusal(verify(await signToken(claims(), impostor)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("kid");
  });

  test("a token signed by another key that claims a published kid", async () => {
    // The signature is real and the header names a key we trust — the key that signed it is not that key.
    const thrown = await refusal(verify(await signToken(claims(), impostor, { kid: key.kid })));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("signature");
  });

  test("claims swapped after signing", async () => {
    const token = await signToken(claims({ sub: "repo:someone/else:environment:npm-publish" }), key);
    const thrown = await refusal(verify(tamperClaims(token, claims())));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("signature");
  });

  test("`alg: none` with an empty signature", async () => {
    // Refused structurally, before a header is even decoded: an unsigned token is three segments the last of
    // which is nothing.
    const token = await signToken(claims(), key, { alg: "none" });
    const [head, body] = token.split(".");
    const thrown = await refusal(verify(`${head}.${body}.`));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("segment is empty");
  });

  test("`alg: none` carrying a real signature", async () => {
    // The header is the half nobody has verified yet, so `alg` is parsed against a literal rather than looked
    // up. A lookup is what makes `none` reachable at all.
    const thrown = await refusal(verify(await signToken(claims(), key, { alg: "none" })));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("token header");
  });

  test("`alg: HS256` signed with the published RSA key as the HMAC secret", async () => {
    // Algorithm confusion, done for real rather than described: the token is HMAC'd with the very bytes the
    // JWKS publishes, which is the attack — a verifier that reads `alg` and dispatches on it would compute
    // the same HMAC with the same public key and agree. The literal is what makes it unreachable.
    const forged = await signHmacWithPublicKey(claims(), key);
    const thrown = await refusal(verify(forged));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("token header");
  });

  test("`alg: RS512`, which the pinned literal excludes even though it is an RSA algorithm", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key, { alg: "RS512" })));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
  });

  test("a header with no kid, because a key is resolved by it", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key, { kid: undefined })));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("token header");
  });

  test("a token that is not three segments", async () => {
    const thrown = await refusal(verify("not-a-token"));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("segments");
  });

  test("a header segment that is not unpadded base64url", async () => {
    // `atob` is famously forgiving — it digests whitespace, and on some runtimes characters that mean
    // nothing. Bytes that decode into *something* are exactly what a forger wants a verifier to work with.
    const [, body, mac] = (await signToken(claims(), key)).split(".");
    const thrown = await refusal(verify(`not base64url!.${body}.${mac}`));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    // The strict alphabet refused it, not `atob` giving up later and not a JSON parse downstream — three
    // different sentences, and only the first one means the segment was never decoded at all.
    expect(thrown.payload.detail).toContain("the token header is not unpadded base64url");
  });

  test("a signature segment that is not unpadded base64url", async () => {
    const [head, body] = (await signToken(claims(), key)).split(".");
    const thrown = await refusal(verify(`${head}.${body}.signature=`));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    // Padding, which RFC 7515 §2 forbids. One token with two spellings is one more thing a comparison can
    // be wrong about, so it is refused rather than tolerated.
    expect(thrown.payload.detail).toContain("the token signature is not unpadded base64url");
  });

  test("a freshness claim outside Date's range, as a refusal and not a RangeError", async () => {
    // `z.number().int()` admits `-1e15`, the comparisons are right for it, and `toISOString()` is not:
    // `new Date(-1e15 * 1000)` throws a `RangeError`, thrown while composing the message for a token that
    // was already refused. Fail-closed either way — but a plain `Error` escaping this module means the
    // sender picks whether they get a 401 or a 500, and a 500 sends an operator into our logs over
    // somebody else's forgery.
    for (const claimed of [claims({ exp: -1e15, nbf: undefined, iat: undefined }), claims({ nbf: 1e15 })]) {
      const thrown = await refusal(verify(await signToken(claimed, key), {}));
      expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
      expect(thrown.payload.status).toBe(401);
      expect(thrown.payload.detail).toContain("epoch second");
    }
  });

  test("an array `aud`, which would turn the boundary into a set membership", async () => {
    const thrown = await refusal(verify(await signToken(claims({ aud: [AUDIENCE, "https://evil.example"] }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("aud");
  });
});

describe("the claims predicate", () => {
  test("refuses a token the issuer minted for another subject", async () => {
    // The token is GitHub's, signed by GitHub, for this exact audience — and it is another repository's
    // release job. `sub` is the only thing that separates them.
    const thrown = await refusal(
      verify(await signToken(claims({ sub: "repo:someone/else:environment:npm-publish" }), key)),
    );
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("not accepted by this endpoint");
  });

  test("its refusal is distinguishable from a signature failure", async () => {
    // One code and one wire response for both — an operator's log is where they separate, and they must,
    // because they send you to different places: a rejected subject is an allowlist to edit, a bad signature
    // is a key or a forgery.
    const rejected = await refusal(verify(await signToken(claims({ sub: "repo:someone/else" }), key)));
    const unsigned = await refusal(verify(await signToken(claims(), impostor, { kid: key.kid })));
    expect(rejected.payload.code).toBe(unsigned.payload.code);
    expect(rejected.payload.detail).not.toBe(unsigned.payload.detail);
    expect(rejected.payload.detail).toContain("claims are not accepted");
    expect(rejected.payload.detail).not.toContain("signature does not match");
    expect(unsigned.payload.detail).toContain("signature does not match");
    expect(unsigned.payload.detail).not.toContain("claims are not accepted");
  });

  test("is handed only proven claims — it never runs on a token that did not verify", async () => {
    let ran = false;
    await refusal(
      verify(await signToken(claims(), impostor, { kid: key.kid }), {
        claims: () => {
          ran = true;
          return true;
        },
      }),
    );
    expect(ran).toBe(false);
  });

  test("may be asynchronous, so a route can look a subject up — and both its answers are awaited", async () => {
    // Asserting only the acceptance is how the `await` goes missing unnoticed: a Promise is truthy, so an
    // unawaited predicate says yes to every caller. The route that pays for it is the one this asynchrony
    // exists for — an allowlist read, a D1 lookup — which would then authenticate every user of the
    // identity provider, all of them holding tokens the issuer really signed.
    await expect(
      verify(await signToken(claims(), key), { claims: async (c: OidcClaims) => c.sub === SUBJECT }),
    ).resolves.toBeDefined();

    const thrown = await refusal(
      verify(await signToken(claims({ sub: "repo:someone/else:environment:npm-publish" }), key), {
        claims: async (c: OidcClaims) => c.sub === SUBJECT,
      }),
    );
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("not accepted by this endpoint");
  });

  test("cannot wave a token past the standard checks", async () => {
    // A predicate that says yes to everything is still refused on the audience: the predicate adds a check,
    // it never replaces one.
    const thrown = await refusal(
      verify(await signToken(claims({ aud: "https://evil.example" }), key), { claims: () => true }),
    );
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("audience");
  });
});

describe("the issuer's published keys", () => {
  test("are fetched when nothing is cached", async () => {
    const seen: string[] = [];
    await expect(
      verify(await signToken(claims(), key), { transport: publishing(JWKS_URL, [key.jwk], seen) }),
    ).resolves.toBeDefined();
    expect(seen).toEqual([JWKS_URL]);
  });

  test("are read from an injected cache without any fetch", async () => {
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    await cache.set(JWKS_URL, [key.jwk], OIDC_JWKS_TTL_SECONDS);
    await expect(
      verify(await signToken(claims(), key), { transport: publishing(JWKS_URL, [], seen), jwksCache: cache }),
    ).resolves.toBeDefined();
    expect(seen).toEqual([]);
  });

  test("cost one fetch for a burst of deliveries when a cache is given", async () => {
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const token = await signToken(claims(), key);
    for (let index = 0; index < 3; index += 1) {
      await verify(token, { transport: publishing(JWKS_URL, [key.jwk], seen), jwksCache: cache });
    }
    expect(seen).toEqual([JWKS_URL]);
  });

  test("are refetched when a token names a kid the cache does not hold", async () => {
    // This is what makes key rotation invisible: a new signing key appears in a token before anything told us
    // to look for it, so an unknown `kid` is a reason to refresh rather than to refuse. Past the refresh
    // window, because the window is the only thing standing between that rule and an unauthenticated flood.
    const seen: string[] = [];
    const rotated = await mintKey("rotated-1");
    let clock = NOW;
    const cache = memoryJwksCache({ now: () => clock });
    let published: OidcJwk[] = [key.jwk];
    const transport: OidcJwksFetch = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: published }) };
    };

    await verify(await signToken(claims(), key), { transport, jwksCache: cache, now: clock });
    expect(seen).toHaveLength(1);
    published = [key.jwk, rotated.jwk];
    clock = new Date(NOW.getTime() + (OIDC_JWKS_MIN_REFRESH_SECONDS + 1) * 1000);
    await expect(
      verify(await signToken(claims(), rotated), { transport, jwksCache: cache, now: clock }),
    ).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
  });

  test("are refetched exactly once for a kid nobody publishes", async () => {
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const thrown = await refusal(
      verify(await signToken(claims(), impostor), {
        transport: publishing(JWKS_URL, [key.jwk], seen),
        jwksCache: cache,
      }),
    );
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(seen).toEqual([JWKS_URL]);
  });

  test("stay bounded at one fetch per window under a flood of attacker-chosen kids", async () => {
    // **The case the first round of this missed.** A `kid` is read out of an unverified header, so a forger
    // picks a new one per delivery for nothing — and a store keyed only on what the issuer published
    // answered none of them, because every random `kid` is a miss and every miss was a fetch. Fifty
    // deliveries, fifty `kid`s nobody has ever published, one round trip: the bound is per window per key
    // endpoint, so the multiplier is a constant and not a function of the attacker's imagination.
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const transport = publishing(JWKS_URL, [key.jwk], seen);
    for (let index = 0; index < 50; index += 1) {
      const thrown = await refusal(verify(await forgedToken(), { transport, jwksCache: cache }));
      // Still a 401 apiece. The bound is on what the refusal costs us, never on whether it refuses.
      expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    }
    expect(seen).toEqual([JWKS_URL]);
  });

  test("are asked again once the window is over, so the flood is a rate and not a single fetch", async () => {
    const seen: string[] = [];
    let clock = NOW;
    const cache = memoryJwksCache({ now: () => clock });
    const transport = publishing(JWKS_URL, [key.jwk], seen);

    await refusal(verify(await forgedToken(), { transport, jwksCache: cache, now: clock }));
    await refusal(verify(await forgedToken(), { transport, jwksCache: cache, now: clock }));
    expect(seen).toHaveLength(1);

    clock = new Date(NOW.getTime() + (OIDC_JWKS_MIN_REFRESH_SECONDS + 1) * 1000);
    await refusal(verify(await forgedToken(), { transport, jwksCache: cache, now: clock }));
    expect(seen).toHaveLength(2);
  });

  test("cost nothing outbound for an invented kid inside the window, and still refuse it as the sender's", async () => {
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const transport = publishing(JWKS_URL, [key.jwk], seen);

    // One genuine delivery fills the store and spends the window.
    await expect(verify(await signToken(claims(), key), { transport, jwksCache: cache })).resolves.toBeDefined();
    const thrown = await refusal(verify(await forgedToken(), { transport, jwksCache: cache }));

    // 401 and not 502: we hold what the issuer published a moment ago, so a `kid` outside it is a `kid` the
    // issuer does not publish. Which of the two it is decides whether the sender is audited or invited back.
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.status).toBe(401);
    expect(seen).toEqual([JWKS_URL]);
  });

  test("are not asked again while the issuer is failing, which would be the same flood one hop over", async () => {
    // A refresh that ends in a 502 has still spent the window. Otherwise the amplifier survives its own
    // fix: nothing is held, every delivery misses, and every miss buys another attempt at an endpoint that
    // is already rate-limiting us — which is the loop that keeps us rate-limited.
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const transport: OidcJwksFetch = async (url) => {
      seen.push(url);
      return { ok: false, status: 429, text: async () => "" };
    };

    const first = await refusal(verify(await signToken(claims(), key), { transport, jwksCache: cache }));
    expect(first).toBeInstanceOf(UpstreamError);
    const second = await refusal(verify(await signToken(claims(), key), { transport, jwksCache: cache }));
    // Still 502 — we hold nothing, so we cannot say the token is the sender's failure. What changed is that
    // saying so costs no outbound request.
    expect(second).toBeInstanceOf(UpstreamError);
    expect(second.payload.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  test("answer a concurrent burst with one ask, because the claim is made before it yields", async () => {
    // Twenty deliveries in flight at once, none of which has seen another's answer. `claimRefresh` decides
    // and records with no `await` between the two, so nineteen of them are refused out of memory. What they
    // are refused *with* is the honest thing: nothing is held yet, so they get the 502 that says we could
    // not look, and Pub/Sub brings a genuine one back a second later.
    const seen: string[] = [];
    const cache = memoryJwksCache({ now: () => NOW });
    const transport = publishing(JWKS_URL, [key.jwk], seen);
    const forged = await Promise.all(Array.from({ length: 20 }, () => forgedToken()));

    await Promise.all(forged.map((token) => refusal(verify(token, { transport, jwksCache: cache }))));

    expect(seen).toEqual([JWKS_URL]);
  });

  test("expire out of the cache, so a rotated set is picked up without an unknown kid", async () => {
    const seen: string[] = [];
    let clock = NOW;
    const cache = memoryJwksCache({ now: () => clock });
    const token = await signToken(claims(), key);
    await verify(token, { transport: publishing(JWKS_URL, [key.jwk], seen), jwksCache: cache, now: clock });
    clock = new Date(NOW.getTime() + (OIDC_JWKS_TTL_SECONDS + 1) * 1000);
    await verify(await signToken(claims({ exp: epochSeconds(clock) + 300 }), key), {
      transport: publishing(JWKS_URL, [key.jwk], seen),
      jwksCache: cache,
      now: clock,
    });
    expect(seen).toHaveLength(2);
  });
});

describe("a failure that is not the sender's", () => {
  test("an unreachable key endpoint is a 502, and still a refusal", async () => {
    // Fail closed on whose code it is, too: a 500 would send an operator into our logs for an outage at an
    // endpoint we do not run, and a 401 would send them after a forger who is not there.
    const thrown = await refusal(
      verify(await signToken(claims(), key), {
        transport: async () => {
          throw new Error("ETIMEDOUT");
        },
      }),
    );
    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(thrown.payload.status).toBe(502);
  });

  test("a key endpoint answering non-2xx is a 502, even when the body would have parsed", async () => {
    // The body is a perfectly good key set — the one an error page never is. So the status is the only
    // thing that can refuse this, which is the point: a 503 from a JWKS endpoint is an outage whatever
    // bytes came with it, and reading a key out of an error response is how a stale set gets trusted.
    const thrown = await refusal(
      verify(await signToken(claims(), key), {
        transport: async () => ({ ok: false, status: 503, text: async () => JSON.stringify({ keys: [key.jwk] }) }),
      }),
    );
    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(thrown.payload.detail).toContain("503");
  });

  test("a key endpoint answering a non-JSON body is a 502", async () => {
    const thrown = await refusal(
      verify(await signToken(claims(), key), {
        transport: async () => ({ ok: true, status: 200, text: async () => "<html>proxy error</html>" }),
      }),
    );
    expect(thrown).toBeInstanceOf(UpstreamError);
  });

  test("an empty key set is a 502, never a pass", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key), { transport: publishing(JWKS_URL, []) }));
    expect(thrown).toBeInstanceOf(UpstreamError);
  });

  test("a non-RSA key the token's kid names is the sender's 401, not the issuer's 502", async () => {
    // **Which key is reached is the sender's choice**, because `kid` arrives in a header nobody has
    // verified. A 502 here would let an anonymous caller pick a code the webhook guard passes through — so
    // the probe never reaches the audit trail, and Pub/Sub is invited to retry it forever. A token naming a
    // key that cannot check its own `alg` is a token nothing can verify, which is what 401 says.
    const cache = memoryJwksCache({ now: () => NOW });
    await cache.set(JWKS_URL, [{ ...key.jwk, kty: "EC" }], OIDC_JWKS_TTL_SECONDS);
    const thrown = await refusal(verify(await signToken(claims(), key), { jwksCache: cache }));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.status).toBe(401);
    expect(thrown.payload.detail).toContain("only RSA keys");
  });

  test("a key the token's kid names that will not import is the sender's 401 too", async () => {
    // The other half of the same door: `crypto.subtle.importKey` refuses a key published for encryption
    // rather than for signatures, and the caller who decided we would reach this key sent the `kid`.
    const cache = memoryJwksCache({ now: () => NOW });
    await cache.set(JWKS_URL, [{ ...key.jwk, use: "enc" }], OIDC_JWKS_TTL_SECONDS);
    const thrown = await refusal(verify(await signToken(claims(), key), { jwksCache: cache }));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.status).toBe(401);
    expect(thrown.payload.detail).toContain("could not be imported");
  });

  test("an endpoint configured with no issuer refuses as our fault, not the sender's", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key), { issuers: [] }));
    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown.payload.status).toBe(500);
  });

  test("an endpoint configured with no audience refuses as our fault", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key), { audience: "" }));
    expect(thrown).toBeInstanceOf(InternalError);
  });

  test("an endpoint configured with no key endpoint refuses as our fault", async () => {
    const thrown = await refusal(verify(await signToken(claims(), key), { jwksUrl: "" }));
    expect(thrown).toBeInstanceOf(InternalError);
  });

  test("a clock that is not a clock refuses rather than waving every expiry through", async () => {
    // The one check in this module that could fail open. Every freshness comparison is `>` or `<` against
    // this number, and NaN answers false to both.
    const thrown = await refusal(verify(await signToken(claims(), key), { now: new Date(Number.NaN) }));
    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown.payload.detail).toContain("clock");
  });

  test("a skew that is not a number refuses rather than waving every expiry through", async () => {
    // The clock's other operand, and unguarded it is the same fail-open one comparison later: `exp + NaN <
    // seconds` is false, so `exp`, `nbf` and `iat` stop deciding anything together. The realistic source is
    // a route reading `Number(env.OIDC_SKEW_SECONDS)` for a variable nobody set — TypeScript types that
    // `number`, and nothing downstream looks at it again.
    const expired = await signToken(claims({ exp: epochSeconds(NOW) - 86_400 }), key);
    const thrown = await refusal(verify(expired, { skewSeconds: Number.NaN }));
    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown.payload.detail).toContain("skew");
    // The discriminating half: the same token, the same key, the same transport — refused as the sender's
    // failure the moment the skew is a real number. Nothing about the token changed.
    expect(await refusal(verify(expired, { skewSeconds: 60 }))).toBeInstanceOf(WebhookUnverifiedError);
  });

  test("a skew wide enough to cover a replay is refused, not clamped", async () => {
    // A tolerance is a replay window stated in seconds, so it is configuration that has to be small rather
    // than merely present. Clamped, a `604800` boots and nobody reads the line again.
    for (const skewSeconds of [Number.POSITIVE_INFINITY, -1, OIDC_MAX_CLOCK_SKEW_SECONDS + 1, 604_800]) {
      const thrown = await refusal(verify(await signToken(claims(), key), { skewSeconds }));
      expect(thrown, String(skewSeconds)).toBeInstanceOf(InternalError);
      expect(thrown.payload.detail, String(skewSeconds)).toContain("skew");
    }
  });

  test("a key-set lifetime that is not a number refuses rather than pinning a rotated key", async () => {
    // Same class, one field over: a cached entry expiring at NaN never expires, so a key the issuer has
    // since withdrawn stays trusted for the life of the isolate.
    const thrown = await refusal(verify(await signToken(claims(), key), { jwksTtlSeconds: Number.NaN }));
    expect(thrown).toBeInstanceOf(InternalError);
    expect(thrown.payload.detail).toContain("lifetime");
  });

  test("a configuration fault is decided before a token is even read", async () => {
    const thrown = await refusal(verify("not-a-token", { issuers: [] }));
    expect(thrown).toBeInstanceOf(InternalError);
  });
});

describe("requireOidcWebhook", () => {
  test("lets a verified delivery reach the handler, body untouched", async () => {
    const token = await signToken(claims(), key);
    const response = await guardedApp().request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event: "release.published" });
  });

  test("accepts the scheme in any case, as RFC 7235 requires", async () => {
    const token = await signToken(claims(), key);
    const response = await guardedApp().request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(200);
  });

  test("refuses a delivery with no authorization header, and buys nothing on its way", async () => {
    const seen: string[] = [];
    const response = await guardedApp({ transport: publishing(JWKS_URL, [key.jwk], seen) }).request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(401);
    // The cheapest rejection: no key set fetched for a caller that presented nothing.
    expect(seen).toEqual([]);
  });

  test("refuses a bare token with no scheme, because `Bearer` is what the header means", async () => {
    // A header value is `<scheme> <credentials>` (RFC 7235). Accepting the credentials alone makes the
    // scheme decorative, and a guard that reads whatever is in the header is a guard that will one day
    // read somebody else's credential out of it.
    const token = await signToken(claims(), key);
    const response = await guardedApp().request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(401);
  });

  test("refuses a header that is not a Bearer token", async () => {
    const response = await guardedApp().request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic aGk6dGhlcmU=" },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(401);
  });

  test("refuses a token for another subject before the handler runs", async () => {
    let reached = false;
    const token = await signToken(claims({ sub: "repo:someone/else:environment:npm-publish" }), key);
    const response = await guardedApp({}, () => {
      reached = true;
    }).request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(401);
    expect(reached).toBe(false);
  });

  test("its 401 carries no detail on the wire", async () => {
    const response = await guardedApp().request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error.code).toBe("core/webhook_unverified");
    // `detail` names the step that refused and `action` names a `pithy` remedy. Both are the operator's.
    expect(body.error.detail).toBeUndefined();
    expect(body.error.action).toBeUndefined();
  });

  test("refuses an expired delivery whatever it is told the clock skew is", async () => {
    // Through the guard, because that is where a skew read out of the environment actually lands, and the
    // guard is the surface that answers 200. A token that expired a day ago reaching the handler is the
    // whole of the fail-open: the delivery is ingested, and nothing in the response says why.
    let reached = false;
    const token = await signToken(claims({ exp: epochSeconds(NOW) - 86_400 }), key);
    const response = await guardedApp({ skewSeconds: Number.NaN }, () => {
      reached = true;
    }).request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(reached).toBe(false);
    // 500 and `core/internal`, not 401: the value that refused this is one we wrote, and an operator sent
    // after a forger would be looking for somebody who is not there.
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("core/internal");
  });

  test("collapses a flood of forged deliveries onto one key fetch, with no cache configured", async () => {
    // A `kid` is published by definition, so one forged token naming it — replayed, unchanged — is the
    // cheapest request an anonymous caller can make. The guard builds its own cache when a route gives
    // none, so the flood costs one round trip to the issuer in total rather than one apiece; without it,
    // the multiplier points at somebody else's endpoint, and the 502 that arrives when they rate-limit us
    // refuses the genuine deliveries alongside the forgeries.
    const seen: string[] = [];
    const app = guardedApp({ transport: publishing(JWKS_URL, [key.jwk], seen) });
    const forged = await signToken(claims(), impostor, { kid: key.kid });
    for (let index = 0; index < 20; index += 1) {
      const response = await app.request("/hooks/release", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${forged}` },
        body: JSON.stringify({ event: "release.published" }),
      });
      expect(response.status).toBe(401);
    }
    expect(seen).toEqual([JWKS_URL]);
  });

  test("collapses one naming a different invented kid every time onto the same one fetch", async () => {
    // The flood above replays one token; this one never sends the same `kid` twice, which is the cheaper
    // attack and the one the store alone did nothing about. Twenty deliveries, twenty `kid`s, one round
    // trip — and twenty 401s, so nothing about the refusal itself changed.
    const seen: string[] = [];
    const app = guardedApp({ transport: publishing(JWKS_URL, [key.jwk], seen) });
    for (let index = 0; index < 20; index += 1) {
      const response = await app.request("/hooks/release", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await forgedToken()}` },
        body: JSON.stringify({ event: "release.published" }),
      });
      expect(response.status).toBe(401);
    }
    expect(seen).toEqual([JWKS_URL]);
  });

  test("does not share that cache with another guard, because it is still not a module global", async () => {
    // The cache is built per guard, which is what keeps the fix from reintroducing the state that made
    // `resetGoogleJwksCache` necessary: two routes get two, and neither can be primed by the other.
    const first: string[] = [];
    const second: string[] = [];
    const token = await signToken(claims(), key);
    const delivery = {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    };
    await guardedApp({ transport: publishing(JWKS_URL, [key.jwk], first) }).request("/hooks/release", delivery);
    await guardedApp({ transport: publishing(JWKS_URL, [key.jwk], second) }).request("/hooks/release", delivery);
    expect(first).toEqual([JWKS_URL]);
    expect(second).toEqual([JWKS_URL]);
  });

  test("reads a token from a header a sender names instead", async () => {
    const token = await signToken(claims(), key);
    const response = await guardedApp({ header: "x-pithy-identity" }).request("/hooks/release", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pithy-identity": `Bearer ${token}` },
      body: JSON.stringify({ event: "release.published" }),
    });
    expect(response.status).toBe(200);
  });
});

/** The one route shape the guard has to survive: a guard, then a json validator, then a handler. */
const Delivery = z
  .object({ event: z.string().describe("The event name the sender assigned.") })
  .describe("A test webhook body, validated after the guard has already proved who sent it.");

function guardedApp(overrides: Record<string, unknown> = {}, onHandler?: () => void) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.post(
    "/hooks/release",
    requireOidcWebhook({
      issuers: [ISSUER],
      jwksUrl: JWKS_URL,
      audience: AUDIENCE,
      claims: (c: OidcClaims) => c.sub === SUBJECT,
      now: () => NOW,
      transport: publishing(JWKS_URL, [key.jwk]),
      ...overrides,
    }),
    zValidator("json", Delivery, validationHook),
    (c) => {
      onHandler?.();
      return c.json({ event: c.req.valid("json").event });
    },
  );
  return app;
}

/** The `PithyError` a call threw. Fails the test rather than returning `undefined` when nothing threw. */
async function refusal(pending: Promise<unknown>): Promise<PithyError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("Expected the verifier to refuse, and it resolved.");
}

/**
 * The algorithm-confusion forgery, built the way an attacker builds it: take the key the JWKS **publishes**,
 * treat those public bytes as a shared secret, HMAC the token with them, and label the header `HS256`.
 *
 * A verifier that dispatches on `alg` would import the same published key as an HMAC secret and agree. The
 * only thing standing between this token and acceptance is the header's pinned literal — which is why this
 * has to be a real HMAC over a real published key rather than a header that merely says `HS256`.
 */
async function signHmacWithPublicKey(payload: unknown, signer: MintedKey): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: signer.kid })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const secret = encoder.encode(JSON.stringify(signer.jwk));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secret as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(`${head}.${body}`) as unknown as ArrayBuffer),
  );
  return `${head}.${body}.${base64Url(signature)}`;
}

/** A compact JWT with its claims swapped for others, keeping the original signature. The tamper case. */
function tamperClaims(token: string, payload: unknown): string {
  const [head, , signature] = token.split(".");
  return `${head}.${base64Url(new TextEncoder().encode(JSON.stringify(payload)))}.${signature}`;
}
