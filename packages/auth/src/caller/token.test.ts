// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS,
  MAX_CALLER_TOKEN_LIFETIME_SECONDS,
  mintCallerToken,
  verifyCallerToken,
} from "./token";

const KEY = "caller-token-key-v1-please-rotate-000000";
const OTHER_KEY = "caller-token-key-v2-please-rotate-111111";
const AUDIENCE = "https://api.example.com";
const NOW = new Date("2026-10-18T12:00:00Z");

/** The key set a verifier holds: version `1` current. */
const KEYS = { versions: { "1": KEY } };

/** A token the trusted backend would mint right now. */
function mint(overrides: Partial<Parameters<typeof mintCallerToken>[0]> = {}): Promise<string> {
  return mintCallerToken({ key: KEY, kid: "1", audience: AUDIENCE, now: NOW, ...overrides });
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Sign arbitrary header and claims with `key`, for the tokens `mintCallerToken` refuses to make. */
async function forge(header: unknown, claims: unknown, key = KEY): Promise<string> {
  const input = `${encode(header)}.${encode(claims)}`;
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(input)));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

describe("verifyCallerToken", () => {
  test("trusts a token minted for this origin, inside its lifetime, with a key it holds", async () => {
    const verdict = await verifyCallerToken(await mint({ subject: "game-server" }), {
      keys: KEYS,
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verdict).toEqual({
      trusted: true,
      claims: {
        aud: AUDIENCE,
        sub: "game-server",
        iat: seconds(NOW),
        exp: seconds(NOW) + DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS,
      },
    });
  });

  test("compares origins, so a path on the configured audience does not change the answer", async () => {
    const verdict = await verifyCallerToken(await mint({ audience: `${AUDIENCE}/scores/` }), {
      keys: KEYS,
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verdict.trusted).toBe(true);
  });

  // The four ways in. Each is a different attack, so each is its own test.

  test("refuses an expired token", async () => {
    const token = await mint({ lifetimeSeconds: 60 });
    const later = new Date(NOW.getTime() + 61_000);
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: later })).toEqual({
      trusted: false,
      reason: "expired",
    });
  });

  test("refuses a token minted for another origin", async () => {
    // A staging token presented to production, or one Worker's token replayed at another sharing the key.
    const token = await mint({ audience: "https://staging.example.com" });
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW })).toEqual({
      trusted: false,
      reason: "audience",
    });
  });

  test("refuses a token signed by the wrong key", async () => {
    const token = await mint({ key: OTHER_KEY });
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW })).toEqual({
      trusted: false,
      reason: "signature",
    });
  });

  test("refuses anything that is not a well-formed HS256 compact JWS", async () => {
    const valid = await mint();
    const [header, claims, signature] = valid.split(".");
    const malformed = [
      "",
      "not-a-token",
      `${header}.${claims}`,
      `${header}.${claims}.${signature}.extra`,
      `${header}..${signature}`,
      `${header}.${claims}.${signature}=`,
      `${header}.${claims}.${signature}+`,
      `${encode("not an object")}.${claims}.${signature}`,
      `${header}.${Buffer.from("{not json").toString("base64url")}.${signature}`,
      // `alg: none` and an asymmetric algorithm — the two classic downgrades — are not HS256.
      await forge({ alg: "none", typ: "JWT", kid: "1" }, { aud: AUDIENCE, iat: seconds(NOW), exp: seconds(NOW) + 60 }),
      await forge({ alg: "RS256", typ: "JWT", kid: "1" }, { aud: AUDIENCE, iat: seconds(NOW), exp: seconds(NOW) + 60 }),
      // Claims that are present but the wrong type.
      await forge({ alg: "HS256", typ: "JWT", kid: "1" }, { aud: AUDIENCE, iat: "now", exp: seconds(NOW) + 60 }),
      await forge(
        { alg: "HS256", typ: "JWT", kid: "1" },
        { aud: [AUDIENCE], iat: seconds(NOW), exp: seconds(NOW) + 60 },
      ),
    ];
    for (const token of malformed) {
      expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW }), token).toEqual({
        trusted: false,
        reason: "malformed",
      });
    }
  });

  test("refuses a key version it does not hold, and never walks the prototype chain to find one", async () => {
    for (const kid of ["2", "__proto__", "constructor", "toString"]) {
      const token = await forge(
        { alg: "HS256", typ: "JWT", kid },
        { aud: AUDIENCE, iat: seconds(NOW), exp: seconds(NOW) + 60 },
      );
      expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW }), kid).toEqual({
        trusted: false,
        reason: "unknown_key",
      });
    }
  });

  test("still trusts a token signed by the previous key during a rotation's overlap", async () => {
    const token = await mint({ kid: "1" });
    const rotated = { versions: { "1": KEY, "2": OTHER_KEY } };
    expect((await verifyCallerToken(token, { keys: rotated, audience: AUDIENCE, now: NOW })).trusted).toBe(true);
  });

  test("checks the signature before any claim, so a forgery learns nothing about the audience", async () => {
    const token = await mint({ key: OTHER_KEY, audience: "https://elsewhere.example.com" });
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW })).toEqual({
      trusted: false,
      reason: "signature",
    });
  });
});

describe("the lifetime ceiling", () => {
  test("defaults to minutes, not hours", () => {
    expect(DEFAULT_CALLER_TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(10 * 60);
    expect(MAX_CALLER_TOKEN_LIFETIME_SECONDS).toBeLessThan(60 * 60);
  });

  test("refuses a correctly signed, unexpired token whose lifetime is longer than the ceiling", async () => {
    // Otherwise valid in every respect: right key, right origin, not expired. A day-long token is a
    // shared secret with extra steps, and this is the check that keeps it from being honored.
    const token = await forge(
      { alg: "HS256", typ: "JWT", kid: "1" },
      { aud: AUDIENCE, iat: seconds(NOW), exp: seconds(NOW) + 24 * 60 * 60 },
    );
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW })).toEqual({
      trusted: false,
      reason: "lifetime",
    });
  });

  test("refuses a token issued in the future, beyond the clock-skew allowance", async () => {
    const token = await forge(
      { alg: "HS256", typ: "JWT", kid: "1" },
      { aud: AUDIENCE, iat: seconds(NOW) + 600, exp: seconds(NOW) + 660 },
    );
    expect(await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW })).toEqual({
      trusted: false,
      reason: "lifetime",
    });
  });

  test("holds a verifier to a tighter ceiling when it asks for one", async () => {
    const token = await mint({ lifetimeSeconds: 120 });
    expect(
      await verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW, maxLifetimeSeconds: 60 }),
    ).toEqual({
      trusted: false,
      reason: "lifetime",
    });
  });

  test("refuses to be configured with a ceiling past the maximum", async () => {
    const token = await mint();
    await expect(
      verifyCallerToken(token, { keys: KEYS, audience: AUDIENCE, now: NOW, maxLifetimeSeconds: 24 * 60 * 60 }),
    ).rejects.toThrow(/lifetime/i);
  });

  test("will not mint a token that outlives the ceiling", async () => {
    await expect(mint({ lifetimeSeconds: MAX_CALLER_TOKEN_LIFETIME_SECONDS + 1 })).rejects.toThrow(/lifetime/i);
  });
});

/**
 * **The wire format, as `docs/server-authoritative.md` states it for a backend that does not import the kit.**
 *
 * Built here with Node's own `crypto`, the way a signer in any language would build it from that page: HS256,
 * `kid` in the header, `aud` one origin string, `iat` and `exp` in whole seconds, unpadded base64url. And the
 * HMAC key is the UTF-8 bytes of the stored string — the base64 text `openssl rand -base64 32` printed, never
 * the 32 bytes it decodes to. A signer that decodes it first is refused on the signature, and that is pinned
 * too, because it is the mistake the page warns against.
 */
describe("the documented wire format", () => {
  const STORED = "q3Jx0m3m9yv0b5mH1oQ5cX8w2c5u1zZ5m3o2Yx9r8Ek=";

  function signLikeAnotherLanguage(key: Buffer | string): string {
    const iat = Math.floor(NOW.getTime() / 1000);
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${segment({ alg: "HS256", typ: "JWT", kid: "1" })}.${segment({ aud: AUDIENCE, iat, exp: iat + 300 })}`;
    return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
  }

  test("a token built from the page alone verifies, keyed with the stored string's UTF-8 bytes", async () => {
    const token = signLikeAnotherLanguage(Buffer.from(STORED, "utf8"));
    const verdict = await verifyCallerToken(token, {
      keys: { versions: { "1": STORED } },
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verdict.trusted).toBe(true);
    // And it is the same token the kit mints, byte for byte.
    expect(token).toBe(await mintCallerToken({ key: STORED, kid: "1", audience: AUDIENCE, now: NOW }));
  });

  test("a token keyed with the base64-decoded bytes is refused on the signature", async () => {
    const token = signLikeAnotherLanguage(Buffer.from(STORED, "base64"));
    const verdict = await verifyCallerToken(token, {
      keys: { versions: { "1": STORED } },
      audience: AUDIENCE,
      now: NOW,
    });
    expect(verdict).toEqual({ trusted: false, reason: "signature" });
  });
});
