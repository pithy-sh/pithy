// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { beforeAll, describe, expect, test } from "vitest";
import { PithyError, UpstreamError, WebhookUnverifiedError } from "../error/pithyError";
import { type OidcClaims, verifyOidcToken } from "../http/oidcWebhook";
import { base64Url, type MintedKey, mintKey, publishing, signToken } from "./oidcFixtures";

/**
 * The shipped fixtures held to the verifier they exist to exercise.
 *
 * A fixture nobody checks against production is worse than no fixture: it can agree with itself and
 * disagree with the code it stands in for, which is exactly what happened to the first adopter who
 * rebuilt these by hand. So every assertion below runs the **real** `verifyOidcToken` — a token these
 * helpers mint, sign and publish is accepted, and a token they deliberately spoil is refused for the
 * reason it was spoiled.
 *
 * **Both halves are load-bearing.** Acceptance alone would pass for a verifier that accepts everything;
 * the refusals alone would pass for helpers that produce garbage. Together they pin the helpers to the
 * wire format: break `base64Url`, `signToken` or `mintKey` and the acceptance case dies, while a
 * refusal that stopped naming its own reason says the token was spoiled somewhere else.
 *
 * The claims here are a plain object rather than a helper, deliberately — see `oidcFixtures.ts` on why
 * a provider's claim shape is the adopter's to write.
 */

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const AUDIENCE = "https://adopter.example/hooks/release";
const SUBJECT = "repo:adopter/app:environment:release";
const NOW = new Date("2026-09-09T12:00:00.000Z");

/** Key generation is the slow part and a key is immutable — one for the suite, plus one impostor. */
let key: MintedKey;
let impostor: MintedKey;

beforeAll(async () => {
  key = await mintKey("fixture-1");
  impostor = await mintKey("impostor-1");
});

/** Seconds since the epoch, the unit every claim below is written in. */
const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** A provider's claims for this endpoint, all valid — the adopter's own object, as the fixtures intend. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    exp: epochSeconds(NOW) + 300,
    iat: epochSeconds(NOW) - 60,
    ...overrides,
  };
}

/** The verifier as an adopter's route configures it: this issuer, this audience, this subject, this key set. */
function verify(token: string, overrides: Record<string, unknown> = {}) {
  return verifyOidcToken(token, {
    issuers: [ISSUER],
    jwksUrl: JWKS_URL,
    audience: AUDIENCE,
    claims: (c: OidcClaims) => c.sub === SUBJECT,
    now: NOW,
    transport: publishing(JWKS_URL, [key.jwk]),
    ...overrides,
  });
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

/** The JSON of a compact JWT's header segment, decoded the way the verifier decodes it. */
function header(token: string): Record<string, unknown> {
  const head = token.split(".")[0] ?? "";
  return JSON.parse(atob(head.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
}

describe("the fixtures produce a token the real verifier accepts", () => {
  test("minted, signed and published — and the claims come back out", async () => {
    // The one case everything else is measured against. If this fails, no refusal below means anything:
    // a token nothing accepts is refused for free.
    const verified = await verify(await signToken(claims({ repository: "adopter/app" }), key));
    expect(verified.iss).toBe(ISSUER);
    expect(verified.aud).toBe(AUDIENCE);
    expect(verified.sub).toBe(SUBJECT);
    expect(verified.repository).toBe("adopter/app");
  });

  test("through a guard's own cache and a second delivery, at one fetch", async () => {
    const seen: string[] = [];
    const token = await signToken(claims(), key);
    await expect(verify(token, { transport: publishing(JWKS_URL, [key.jwk], seen) })).resolves.toBeDefined();
    await expect(verify(token, { transport: publishing(JWKS_URL, [key.jwk], seen) })).resolves.toBeDefined();
    expect(seen).toEqual([JWKS_URL, JWKS_URL]);
  });

  test("`signToken` writes the header a provider writes, unless a test overrides it", async () => {
    expect(header(await signToken(claims(), key))).toEqual({ alg: "RS256", typ: "JWT", kid: key.kid });
    expect(header(await signToken(claims(), key, { alg: "none" })).alg).toBe("none");
  });

  test("`mintKey` publishes the key it signs with, under the kid it was asked for", async () => {
    expect(key.jwk.kid).toBe("fixture-1");
    expect(key.jwk.kty).toBe("RSA");
    expect(key.jwk.alg).toBe("RS256");
    expect(key.jwk.use).toBe("sig");
    // The modulus is the public half of the pair that signed the accepted token above, so the verifier
    // already proved they match. What this adds is that two keys are two keys.
    expect(impostor.jwk.n).not.toBe(key.jwk.n);
  });

  test("`base64Url` is unpadded and url-safe, which is the only encoding a JWS segment has", async () => {
    // `0xfb 0xff 0xbf` is `+/+/` in standard base64 with padding: every character this must not emit.
    expect(base64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(base64Url(new TextEncoder().encode("a"))).toBe("YQ");
    for (const segment of (await signToken(claims(), key)).split(".")) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("the fixtures produce a token the real verifier refuses", () => {
  test("signed by a key the issuer does not publish", async () => {
    // Two minted keys, only one published: the refusal is the verifier resolving a `kid` it has never
    // seen, not a stub told to say no.
    const thrown = await refusal(verify(await signToken(claims(), impostor)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("kid");
  });

  test("signed by another key that claims a published kid", async () => {
    // The header override is what makes this reachable at all — a real signature under a `kid` we trust,
    // which is the forgery an adopter's route must refuse and cannot otherwise be handed.
    const thrown = await refusal(verify(await signToken(claims(), impostor, { kid: key.kid })));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("signature");
  });

  test("with claims swapped after signing", async () => {
    // `base64Url` re-encodes the swapped segment; the signature is the original one. Refused on the
    // signature rather than on the claims, which is the whole point of the tamper case.
    const token = await signToken(claims({ sub: "repo:someone/else:environment:release" }), key);
    const [head, , signature] = token.split(".");
    const swapped = `${head}.${base64Url(new TextEncoder().encode(JSON.stringify(claims())))}.${signature}`;
    const thrown = await refusal(verify(swapped));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("signature");
  });

  test("minted for another audience", async () => {
    const thrown = await refusal(verify(await signToken(claims({ aud: "https://evil.example/hooks" }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("audience");
  });

  test("from an issuer the endpoint does not accept", async () => {
    const thrown = await refusal(verify(await signToken(claims({ iss: `${ISSUER}.evil.example` }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("issuer");
  });

  test("expired", async () => {
    const thrown = await refusal(verify(await signToken(claims({ exp: epochSeconds(NOW) - 3600 }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("expired");
  });

  test("carrying a subject the claims predicate rejects", async () => {
    // Signed by the right key, for the right endpoint, by the right issuer — and somebody else's job.
    const thrown = await refusal(verify(await signToken(claims({ sub: "repo:someone/else" }), key)));
    expect(thrown).toBeInstanceOf(WebhookUnverifiedError);
    expect(thrown.payload.detail).toContain("not accepted by this endpoint");
  });

  test("headed `alg: none`, and `alg: RS512`, and no kid at all", async () => {
    // The three header overrides the fixture exists to make possible. Each is a header no provider emits,
    // so without the override an adopter cannot prove their route refuses it.
    for (const spoiled of [{ alg: "none" }, { alg: "RS512" }, { kid: undefined }]) {
      const thrown = await refusal(verify(await signToken(claims(), key, spoiled)));
      expect(thrown, JSON.stringify(spoiled)).toBeInstanceOf(WebhookUnverifiedError);
      expect(thrown.payload.detail, JSON.stringify(spoiled)).toContain("token header");
    }
  });
});

describe("`publishing` answers as `OidcJwksResponse` declares", () => {
  test("with a text body and no json method — the mistake that 502'd an adopter's every delivery", async () => {
    // The bug this module exists to make unrepresentable, asserted at runtime as well as in the types: the
    // verifier reads `text()` so that a proxy's HTML error page is a diagnosis rather than a throw, and a
    // fixture answering `json()` looks correct and fails every delivery.
    const response = await publishing(JWKS_URL, [key.jwk])(JWKS_URL);
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect("json" in response).toBe(false);
    const body = await response.text();
    expect(typeof body).toBe("string");
    expect(JSON.parse(body)).toEqual({ keys: [key.jwk] });
  });

  test("with a 404 at any other url, so a route pointed at the wrong endpoint fails", async () => {
    // A wildcard transport would pass a route whose `jwksUrl` is a typo — the one configuration mistake a
    // webhook route's test is there to catch. The verifier maps the non-2xx to a 502, not a 401: an
    // endpoint that will not answer is nobody's forgery.
    const seen: string[] = [];
    const elsewhere = await publishing(JWKS_URL, [key.jwk], seen)("https://typo.example/jwks");
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.status).toBe(404);

    const thrown = await refusal(
      verify(await signToken(claims(), key), {
        jwksUrl: "https://typo.example/jwks",
        transport: publishing(JWKS_URL, [key.jwk], seen),
      }),
    );
    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(thrown.payload.status).toBe(502);
    expect(seen).toEqual(["https://typo.example/jwks", "https://typo.example/jwks"]);
  });

  test("and records every url it was asked for, so a cached path can prove it never fetched", async () => {
    const seen: string[] = [];
    await expect(
      verify(await signToken(claims(), key), { transport: publishing(JWKS_URL, [key.jwk], seen) }),
    ).resolves.toBeDefined();
    expect(seen).toEqual([JWKS_URL]);
  });
});
