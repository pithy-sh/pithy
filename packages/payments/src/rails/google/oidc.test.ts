// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  memoryJwksCache,
  OIDC_JWKS_MIN_REFRESH_SECONDS,
  OIDC_MAX_CLOCK_SKEW_SECONDS,
} from "@pithy-sh/core/src/http/oidcWebhook";
import { beforeAll, describe, expect, test } from "vitest";
import { PaymentsVerificationFailedError } from "../../error/errors";
import { type MintedOidcKey, mintOidcKey, signOidcToken, tamperClaims } from "./fixtures/push";
import type { GoogleHttpFetch } from "./http";
import { GOOGLE_JWKS_URL, type GoogleJwk, verifyGoogleOidcToken } from "./oidc";

/**
 * The authenticity boundary on the Google webhook, exercised for real: a minted RSA key, real RS256
 * signatures, and a verifier given only the key it should trust.
 *
 * **The audience check is the boundary, not the signature.** Every token below is genuinely signed by Google's
 * own key in the eyes of the verifier — that is what makes the `aud` case the important one. Google signs the
 * push token for *every* Pub/Sub push subscription in the world with the same keys, so a signature alone says
 * nothing about whose endpoint the token was minted for. Without the audience check, anybody who can point a
 * push subscription at our URL can deliver notifications we will accept.
 *
 * **The verification itself is core's since #520**, so these cases are the rail's contract over it: Google's
 * issuers, Google's key endpoint, Google's service-account pair, and the code a refusal carries. The forgery
 * cases stay here rather than being left to core's suite — a rail that tests only the happy path after
 * delegating is a rail that would not notice core regressing.
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

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a negative skew", -1],
    ["wider than the maximum", OIDC_MAX_CLOCK_SKEW_SECONDS + 1],
  ])(
    "refuses a decade-expired token when the skew is %s, as our fault rather than the sender's",
    async (_label, clockSkewSeconds) => {
      // `exp + NaN < seconds` and `iat - NaN > seconds` are both false, so one unchecked number does not widen
      // the window — it removes `exp` and `iat` together, and a captured push token replays forever under a
      // signature that really is Google's. The realistic source is `Number(env.GOOGLE_SKEW)` on a variable
      // nobody set. `core/internal`, because the sender did nothing wrong.
      const ancient = Math.floor(NOW.getTime() / 1000) - 10 * 365 * 24 * 3600;
      const token = await signOidcToken(claims({ exp: ancient, iat: ancient - 60 }), key);
      const thrown = await catchError(async () => verify(token, { clockSkewSeconds }));
      expect(thrown?.payload.code).toBe("core/internal");
      expect(thrown?.payload.status).toBe(500);
    },
  );

  test("that same token is refused as expired under an honest skew", async () => {
    // The half that keeps the cases above about the skew rather than about the token.
    const ancient = Math.floor(NOW.getTime() / 1000) - 10 * 365 * 24 * 3600;
    const token = await signOidcToken(claims({ exp: ancient, iat: ancient - 60 }), key);
    expect((await catchError(async () => verify(token, { clockSkewSeconds: 60 })))?.payload.detail).toContain(
      "expired",
    );
    expect((await catchError(async () => verify(token)))?.payload.code).toBe("payments/verification_failed");
  });

  test("a clock that is not a clock fails closed, the same fault one operand over", async () => {
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims(), key), { now: new Date("not a date") }),
    );
    expect(thrown?.payload.code).toBe("core/internal");
    expect(thrown?.payload.status).toBe(500);
  });

  test("a finite skew inside the bound still widens the window it is given", async () => {
    const justPast = Math.floor(NOW.getTime() / 1000) - 120;
    await expect(
      verify(await signOidcToken(claims({ exp: justPast }), key), { clockSkewSeconds: 300 }),
    ).resolves.toBeDefined();
    await expect(verify(await signOidcToken(claims({ exp: justPast }), key))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses a token that is not yet valid", async () => {
    // `nbf` is a claim the rail's own verifier never read: a token minted for an hour from now verified
    // immediately under it. Core honors it, and delegating is what the rail gets it from.
    const thrown = await catchError(async () =>
      verify(await signOidcToken(claims({ nbf: Math.floor(NOW.getTime() / 1000) + 3600 }), key)),
    );
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("not valid before");
  });

  test("allows the same clock skew on `nbf` as on the other two", async () => {
    const almost = Math.floor(NOW.getTime() / 1000) + 30;
    await expect(verify(await signOidcToken(claims({ nbf: almost }), key))).resolves.toBeDefined();
  });

  test("an expiry outside Date's range is refused, not a RangeError composing the refusal", async () => {
    // The refusal message renders the claim as an instant, and `new Date(-1e18).toISOString()` throws a bare
    // `RangeError` — a plain Error escaping a path whose every other exit is a `PithyError`. Through the
    // webhook guard that turned a forgery into a 500, which is a forger choosing our status code.
    const thrown = await catchError(async () => verify(await signOidcToken(claims({ exp: -1e15 }), key)));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("expired");
  });

  test("a not-before outside Date's range is refused the same way", async () => {
    const thrown = await catchError(async () => verify(await signOidcToken(claims({ nbf: 1e15 }), key)));
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.detail).toContain("not valid before");
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative lifetime", -1],
  ])("refuses a key-set lifetime of %s as our fault rather than the sender's", async (_label, jwksTtlSeconds) => {
    // A non-finite lifetime is an entry that expires at NaN, and `NaN <= now` is false forever — so a key the
    // issuer has rotated out stays trusted for the life of the isolate. A key pin nobody chose.
    const thrown = await catchError(async () => verify(await signOidcToken(claims(), key), { jwksTtlSeconds }));
    expect(thrown?.payload.code).toBe("core/internal");
    expect(thrown?.payload.status).toBe(500);
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

  // The five cases below read `payments/verification_failed` where they once read `payments/invalid_receipt`.
  // That split means *the receipt could not be read*, and a Pub/Sub push token is not a receipt — it is a
  // webhook credential, on a path where the guard already collapsed both codes to `payments/webhook_unverified`
  // (401) before anything reached the sender. Both are 400 on the direct path, so the change is visible only in
  // the audit row's `metadata.step`. Deliberate, and stated in `oidc.ts`.
  test("refuses `alg: none` with an empty signature", async () => {
    const token = await signOidcToken(claims(), key, { alg: "none" });
    const [head, body] = token.split(".");
    await expect(verify(`${head}.${body}.`)).rejects.toBeInstanceOf(PaymentsVerificationFailedError);
  });

  test("refuses `alg: none` carrying a real signature", async () => {
    // The header is the half nobody has verified yet, so `alg` is parsed against a literal rather than looked
    // up. A lookup is what makes `none` reachable.
    await expect(verify(await signOidcToken(claims(), key, { alg: "none" }))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses `alg: HS256` — the confusion that asks a verifier to HMAC with a public key", async () => {
    await expect(verify(await signOidcToken(claims(), key, { alg: "HS256" }))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses `alg: RS512`, which the pinned literal excludes even though it is an RSA algorithm", async () => {
    await expect(verify(await signOidcToken(claims(), key, { alg: "RS512" }))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses a header with no kid", async () => {
    await expect(verify(await signOidcToken(claims(), key, { kid: undefined }))).rejects.toBeInstanceOf(
      PaymentsVerificationFailedError,
    );
  });

  test("refuses a token that is not three segments", async () => {
    await expect(verify("not-a-token")).rejects.toBeInstanceOf(PaymentsVerificationFailedError);
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

  test("are cached when a cache is passed, so a burst of notifications costs one fetch", async () => {
    // The cache is a parameter now, not a module variable. That is what deleted `resetGoogleJwksCache`: a
    // store no caller owns is a store only an exported reset can empty between suites.
    const seen: string[] = [];
    const transport = publishing([key.jwk], seen);
    const jwksCache = memoryJwksCache({ now: () => NOW });
    const token = await signOidcToken(claims(), key);
    for (let i = 0; i < 3; i += 1) {
      await verifyGoogleOidcToken(token, {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        transport,
        jwksCache,
      });
    }
    expect(seen).toEqual([GOOGLE_JWKS_URL]);
  });

  test("are fetched per delivery when no cache is passed", async () => {
    // The other half, and the one that says what removing the module global costs. Correct and slow beats a
    // store nothing can empty; a Worker that wants the round trip back passes a `JwksCache`.
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
    expect(seen).toHaveLength(3);
  });

  test("are refetched when a token names a kid the cache does not hold", async () => {
    // This is what makes Google's key rotation invisible: a new signing key appears in a token before anything
    // told us to look for it, so an unknown `kid` is a reason to refresh rather than to refuse. Once the
    // refresh window is over, because that window is what stops the same rule being an outbound amplifier —
    // a `kid` is attacker-chosen, so "refresh on an unknown one" with no rate is one fetch per forgery.
    const seen: string[] = [];
    const rotated = await mintOidcKey("rotated-1");
    let published = [key.jwk];
    let clock = NOW;
    const transport: GoogleHttpFetch = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ keys: published }) };
    };
    const jwksCache = memoryJwksCache({ now: () => clock });
    const options = { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT, transport, jwksCache };

    await verifyGoogleOidcToken(await signOidcToken(claims(), key), { ...options, now: clock });
    published = [rotated.jwk];
    clock = new Date(NOW.getTime() + (OIDC_JWKS_MIN_REFRESH_SECONDS + 1) * 1000);
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), rotated), { ...options, now: clock }),
    ).resolves.toBeDefined();
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

  test("a configured key never reaches the shared cache", async () => {
    // The seeding shape, refused. Writing `trustedKeys` into the store is the obvious way to hand them to core
    // and it widens trust sideways: the store is shared, so an emulator's key — or this suite's — would read
    // back as a key *Google publishes* to every other verifier holding the same cache, including one that was
    // never given it. Keeping them in a wrapper means they are additive for their own caller and invisible to
    // everyone else.
    const jwksCache = memoryJwksCache({ now: () => NOW });
    const published = await mintOidcKey("google-side-2");
    const shared = { audience: AUDIENCE, serviceAccountEmail: SERVICE_ACCOUNT, now: NOW, jwksCache };

    await verifyGoogleOidcToken(await signOidcToken(claims(), key), {
      ...shared,
      trustedKeys: [key.jwk],
      transport: publishing([published.jwk]),
    });
    await expect(
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        ...shared,
        transport: publishing([published.jwk]),
      }),
    ).rejects.toBeInstanceOf(PaymentsVerificationFailedError);
  });

  test("a non-RSA key the token's kid names is the rail's 401, audited, and not Google's 502", async () => {
    // **Which key is reached is the sender's choice.** `kid` arrives in an unverified header, so a 502 here
    // would be a code an anonymous caller picks by naming one `kid` instead of another — and this rail passes
    // `core/upstream_failed` straight through the webhook guard, which means no `payments/webhook_unverified`
    // audit row for the probe and an indefinite Pub/Sub retry for the prober. Core answers 401; the rail
    // re-codes it like every other refusal, so the trail sees it.
    const thrown = await catchError(async () =>
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        trustedKeys: [{ ...key.jwk, kty: "EC" }],
      }),
    );
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.code).toBe("payments/verification_failed");
    expect(thrown?.payload.detail).toContain("only RSA keys");
  });

  test("a key the token's kid names that will not import is the rail's 401 too", async () => {
    const thrown = await catchError(async () =>
      verifyGoogleOidcToken(await signOidcToken(claims(), key), {
        audience: AUDIENCE,
        serviceAccountEmail: SERVICE_ACCOUNT,
        now: NOW,
        trustedKeys: [{ ...key.jwk, use: "enc" }],
      }),
    );
    expect(thrown).toBeInstanceOf(PaymentsVerificationFailedError);
    expect(thrown?.payload.code).toBe("payments/verification_failed");
    expect(thrown?.payload.detail).toContain("could not be imported");
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
