// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { type MintedOidcKey, mintOidcKey, signOidcToken, tamperClaims } from "./fixtures/push";
import type { GoogleHttpFetch } from "./http";
import { GOOGLE_JWKS_URL, type GoogleJwk, resetGoogleJwksCache, verifyGoogleOidcToken } from "./oidc";

/**
 * The authenticity boundary on the Google webhook, exercised for real: a minted RSA key, real RS256
 * signatures, and a verifier given only the key it should trust.
 *
 * **The audience check is the boundary, not the signature.** Every token below is genuinely signed by Google's
 * own key in the eyes of the verifier — that is what makes the `aud` case the important one. Google signs the
 * push token for *every* Pub/Sub push subscription in the world with the same keys, so a signature alone says
 * nothing about whose endpoint the token was minted for. Without the audience check, anybody who can point a
 * push subscription at our URL can deliver notifications we will accept.
 */

const AUDIENCE = "https://acme.example/payments/webhooks/google";
const SERVICE_ACCOUNT = "pithy-rtdn@acme-42.iam.gserviceaccount.com";
const NOW = new Date("2026-01-15T00:00:00.000Z");

/** Key generation is the slow part, and a key is immutable — one for the suite, plus one impostor. */
let key: MintedOidcKey;
let impostor: MintedOidcKey;

beforeAll(async () => {
  key = await mintOidcKey();
  impostor = await mintOidcKey("impostor-1");
});

afterEach(() => resetGoogleJwksCache());

/** The claims Google puts on a Pub/Sub push token, all valid. */
function claims(overrides: Record<string, unknown> = {}) {
  return {
    aud: AUDIENCE,
    azp: "112233445566778899000",
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    iat: Math.floor(NOW.getTime() / 1000) - 60,
    iss: "https://accounts.google.com",
    sub: "112233445566778899000",
    ...overrides,
  };
}

/** The verifier, given the suite's key directly rather than through a fetch. */
function verify(token: string, overrides: Record<string, unknown> = {}) {
  return verifyGoogleOidcToken(token, {
    audience: AUDIENCE,
    serviceAccountEmail: SERVICE_ACCOUNT,
    now: NOW,
    trustedKeys: [key.jwk],
    ...overrides,
  });
}

/** A transport that publishes `keys` at Google's JWKS URL and refuses every other request. */
function publishing(keys: GoogleJwk[], seen: string[] = []): GoogleHttpFetch {
  return async (url) => {
    seen.push(url);
    if (url !== GOOGLE_JWKS_URL) return { ok: false, status: 404, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys }) };
  };
}

describe("verifyGoogleOidcToken", () => {
  test("accepts a token Google signed for this endpoint", async () => {
    const verified = await verify(await signOidcToken(claims(), key));
    expect(verified.aud).toBe(AUDIENCE);
    expect(verified.email).toBe(SERVICE_ACCOUNT);
  });

  test("refuses a token minted for another endpoint, however well signed", async () => {
    // The case the whole check exists for. Same key, same issuer, valid signature, valid dates — and it is a
    // token Google issued for somebody else's push subscription.
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ aud: "https://evil.example/hook" }), key)),
    );
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("audience");
  });

  test("refuses a token with no audience at all", async () => {
    // A claim set missing a required claim is refused after the signature verifies, so it reads as "Google
    // signed something that is not a push token" rather than as an unreadable token.
    const thrown = await catchError(async () => verify(await signOidcToken(claims({ aud: undefined }), key)));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("aud");
  });

  test("refuses an issuer that is not Google", async () => {
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ iss: "https://accounts.google.com.evil.example" }), key)),
    );
    expect(thrown?.payload.detail).toContain("issuer");
  });

  test("accepts Google's bare-host issuer spelling as well as the URL one", async () => {
    // Google publishes tokens under both `accounts.google.com` and `https://accounts.google.com`, and which
    // one arrives is not ours to decide.
    await expect(verify(await signOidcToken(claims({ iss: "accounts.google.com" }), key))).resolves.toBeDefined();
  });

  test("refuses an expired token", async () => {
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ exp: Math.floor(NOW.getTime() / 1000) - 120 }), key)),
    );
    expect(thrown?.payload.detail).toContain("expired");
  });

  test("allows a small clock skew on expiry, and no more", async () => {
    // Pub/Sub mints a token an hour ahead, so a token that is seconds past expiry means our clock drifted, not
    // that the delivery is a replay. A minute of tolerance costs nothing; an hour would.
    const almost = Math.floor(NOW.getTime() / 1000) - 30;
    await expect(verify(await signOidcToken(claims({ exp: almost }), key))).resolves.toBeDefined();
    const stale = Math.floor(NOW.getTime() / 1000) - 3600;
    await expect(verify(await signOidcToken(claims({ exp: stale }), key))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses a token issued in the future beyond the skew", async () => {
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ iat: Math.floor(NOW.getTime() / 1000) + 3600 }), key)),
    );
    expect(thrown?.payload.detail).toContain("issued");
  });

  test("refuses a token signed by a key Google never published", async () => {
    // The impostor's `kid` is unknown, so the lookup fails before any signature work.
    const thrown = await catchError(async () => verify(await signOidcToken(claims(), impostor)));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("kid");
  });

  test("refuses a token signed by another key that claims a published kid", async () => {
    // The signature is real and the header names a key we trust — the key that signed it is not that key.
    const thrown = await catchError(async () => verify(await signOidcToken(claims(), impostor, { kid: key.kid })));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("signature");
  });

  test("refuses claims changed after signing", async () => {
    const token = await signOidcToken(claims(), key);
    const thrown = await catchError(() => verify(tamperClaims(token, claims({ aud: AUDIENCE, email: "x@y.z" }))));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("signature");
  });

  test("refuses `alg: none` with an empty signature", async () => {
    const token = await signOidcToken(claims(), key, { alg: "none" });
    const [head, body] = token.split(".");
    await expect(verify(`${head}.${body}.`)).rejects.toBeInstanceOf(PaymentsInvalidReceiptError);
  });

  test("refuses `alg: none` carrying a real signature", async () => {
    // The header is the half nobody has verified yet, so `alg` is parsed against a literal rather than looked
    // up. A lookup is what makes `none` reachable.
    await expect(verify(await signOidcToken(claims(), key, { alg: "none" }))).rejects.toBeInstanceOf(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses `alg: HS256` — the confusion that asks a verifier to HMAC with a public key", async () => {
    await expect(verify(await signOidcToken(claims(), key, { alg: "HS256" }))).rejects.toBeInstanceOf(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses `alg: RS512`, which the pinned literal excludes even though it is an RSA algorithm", async () => {
    await expect(verify(await signOidcToken(claims(), key, { alg: "RS512" }))).rejects.toBeInstanceOf(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses a header with no kid", async () => {
    await expect(verify(await signOidcToken(claims(), key, { kid: undefined }))).rejects.toBeInstanceOf(
      PaymentsInvalidReceiptError,
    );
  });

  test("refuses a token that is not three segments", async () => {
    await expect(verify("not-a-token")).rejects.toBeInstanceOf(PaymentsInvalidReceiptError);
  });

  test("refuses a service account other than the configured one", async () => {
    // Google's own guidance, and a second boundary: the audience says the token was minted for our endpoint,
    // the email says which identity Pub/Sub used to mint it.
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ email: "someone-else@acme-42.iam.gserviceaccount.com" }), key)),
    );
    expect(thrown?.payload.detail).toContain("service account");
  });

  test("refuses a token whose email Google did not verify", async () => {
    const thrown = await catchError(async () => verify(await signOidcToken(claims({ email_verified: false }), key)));
    expect(thrown?.payload.detail).toContain("verified");
  });
});

describe("Google's published keys", () => {
  test("are fetched when no configured key matches the token's kid", async () => {
    const seen: string[] = [];
    const verified = await verifyGoogleOidcToken(await signOidcToken(claims(), key), {
      audience: AUDIENCE,
      serviceAccountEmail: SERVICE_ACCOUNT,
      now: NOW,
      transport: publishing([key.jwk], seen),
    });
    expect(verified.aud).toBe(AUDIENCE);
    expect(seen).toEqual([GOOGLE_JWKS_URL]);
  });

  test("are cached, so a burst of notifications costs one fetch", async () => {
    const seen: string[] = [];
    const transport = publishing([key.jwk], seen);
    const token = await signOidcToken(claims(), key);
    for (let i = 0; i < 3; i += 1) {
      await verifyGoogleOidcToken(token, {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        transport,
      });
    }
    expect(seen).toEqual([GOOGLE_JWKS_URL]);
  });

  test("are refetched once when a token names a kid the cache does not hold", async () => {
    // This is what makes Google's key rotation invisible: a new signing key appears in a token before anything
    // told us to look for it, so an unknown `kid` is a reason to refresh rather than to refuse.
    const seen: string[] = [];
    const rotated = await mintOidcKey("rotated-1");
    let published = [key.jwk];
    const transport: GoogleHttpFetch = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: published }) };
    };
    const options = { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT, now: NOW, transport };

    await verifyGoogleOidcToken(await signOidcToken(claims(), key), options);
    published = [rotated.jwk];
    await expect(verifyGoogleOidcToken(await signOidcToken(claims(), rotated), options)).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
  });

  test("a kid nobody publishes is refused after exactly one refresh", async () => {
    // The refresh is bounded. An unknown `kid` on every forged token must not be a way to make us hammer
    // Google's key endpoint.
    const seen: string[] = [];
    const transport = publishing([key.jwk], seen);
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), impostor), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        transport,
      }),
    ).rejects.toBeInstanceOf(PaymentsVerificationFailedError);
    expect(seen).toHaveLength(1);
  });

  test("an unreachable key endpoint is a failure, never a pass", async () => {
    // A verifier that cannot fetch a key must deny. Fail-closed, like every other gate.
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        transport: async () => {
          throw new Error("ETIMEDOUT");
        },
      }),
    ).rejects.toThrow();
  });

  test("a key endpoint answering an unexpected shape is a failure", async () => {
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        transport: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ keys: [] }) }),
      }),
    ).rejects.toThrow();
  });

  test("a configured key is used without any fetch", async () => {
    // The seam the tests and a Pub/Sub emulator need. Additive: it adds a key to the set, and Google's own keys
    // are still fetched for any `kid` it does not cover.
    const seen: string[] = [];
    await verifyGoogleOidcToken(await signOidcToken(claims(), key), {
      audience: AUDIENCE,
      serviceAccountEmail: SERVICE_ACCOUNT,
      now: NOW,
      trustedKeys: [key.jwk],
      transport: publishing([], seen),
    });
    expect(seen).toEqual([]);
  });

  test("a configured key does not shadow Google's for another kid", async () => {
    const seen: string[] = [];
    const rotated = await mintOidcKey("google-side-1");
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), rotated), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        trustedKeys: [key.jwk],
        transport: publishing([rotated.jwk], seen),
      }),
    ).resolves.toBeDefined();
    expect(seen).toEqual([GOOGLE_JWKS_URL]);
  });

  test("a non-RSA published key is refused rather than imported", async () => {
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        trustedKeys: [{ ...key.jwk, kty: "EC" }],
      }),
    ).rejects.toThrow();
  });
});

/** The thrown `PithyError`, or undefined. */
async function catchError(run: () => Promise<unknown>): Promise<PaymentsVerificationFailedError | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as PaymentsVerificationFailedError;
  }
}
