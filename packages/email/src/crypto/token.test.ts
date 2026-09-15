// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mintToken, verifyToken } from "./token";

const KEYS_V1 = { currentVersion: "1", versions: { "1": "super-secret-signing-key-one" } };
const KEYS_V2 = {
  currentVersion: "2",
  versions: { "1": "super-secret-signing-key-one", "2": "super-secret-signing-key-two" },
};
const KEYS_V2_ONLY = { currentVersion: "2", versions: { "2": "super-secret-signing-key-two" } };

const now = new Date("2026-06-18T00:00:00.000Z");
/** The origin every token outside the audience cases is minted for and presented at. */
const AUD = "https://acme.test";
const expiresAt = new Date("2026-09-18T00:00:00.000Z");

const clickClaims = {
  kind: "click" as const,
  jobId: "job-1",
  recipient: "u@example.com",
  destination: "https://example.com/welcome",
  linkLabel: "cta",
  campaignId: "spring",
};

describe("callback token sign/verify", () => {
  test("a minted token round-trips to its claims", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const claims = await verifyToken(token, KEYS_V1, now, AUD);
    expect(claims).toMatchObject(clickClaims);
    expect(claims.kid).toBe("1");
  });

  test("a tampered payload is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const [payloadB64, sig] = token.split(".");
    const forged = `${payloadB64}x.${sig}`;
    await expect(verifyToken(forged, KEYS_V1, now, AUD)).rejects.toThrow();
  });

  test("a tampered signature is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const [payloadB64] = token.split(".");
    await expect(verifyToken(`${payloadB64}.AAAA`, KEYS_V1, now, AUD)).rejects.toThrow();
  });

  test("a malformed token (no signature segment) is rejected", async () => {
    await expect(verifyToken("not-a-token", KEYS_V1, now, AUD)).rejects.toThrow();
  });

  test("an expired token is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const afterExpiry = new Date("2026-09-19T00:00:00.000Z");
    await expect(verifyToken(token, KEYS_V1, afterExpiry, AUD)).rejects.toThrow();
  });

  test("a token signed under an old kid still verifies while that version is retained", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    // Rotation happened: current is now v2, but v1 is still in the valid set.
    const claims = await verifyToken(token, KEYS_V2, now, AUD);
    expect(claims.jobId).toBe("job-1");
  });

  test("a token whose kid has been pruned from the valid set is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    await expect(verifyToken(token, KEYS_V2_ONLY, now, AUD)).rejects.toThrow();
  });

  test("a token signed with the wrong key for its kid is rejected", async () => {
    // Same kid "1" but the verifier holds a different secret for version 1.
    const token = await mintToken(clickClaims, { key: "an-attacker-key", kid: "1", expiresAt, audience: AUD });
    await expect(verifyToken(token, KEYS_V1, now, AUD)).rejects.toThrow();
  });

  // A `kid` that walks the prototype chain (`__proto__`, `constructor`) must not resolve to a usable
  // key — otherwise an attacker forges tokens against the coerced `"[object Object]"` / Object source.
  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "a prototype-chain kid (%s) is rejected, not used as a key",
    async (kid) => {
      const forgeKey = kid === "__proto__" ? "[object Object]" : String(({} as Record<string, unknown>)[kid]);
      const token = await mintToken(clickClaims, { key: forgeKey, kid, expiresAt, audience: AUD });
      await expect(verifyToken(token, KEYS_V1, now, AUD)).rejects.toMatchObject({
        payload: { code: "email/invalid_token" },
      });
    },
  );
});

/**
 * **A token names the origin it was minted for (#596).** Every link points at the environment that minted
 * it, so that origin is the only one entitled to act on it. Without the claim, a key ever shared between
 * staging and production made a staging token a valid credential on production's callback routes —
 * including the unsubscribe route, which writes into the suppression list both environments bind.
 */
describe("the audience claim", () => {
  const STAGING = "https://staging.acme.test";
  const PROD = "https://acme.test";

  test("a token verifies at the origin it was minted for", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: STAGING });
    const claims = await verifyToken(token, KEYS_V1, now, STAGING);
    expect(claims.aud).toBe(STAGING);
  });

  test("the same token, under the same key, is refused at another origin", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: STAGING });
    await expect(verifyToken(token, KEYS_V1, now, PROD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });

  test("an audience is an origin: a path, a trailing slash or a port-less default does not change it", async () => {
    const token = await mintToken(clickClaims, {
      key: KEYS_V1.versions["1"],
      kid: "1",
      expiresAt,
      audience: "https://acme.test:443/app/",
    });
    await expect(verifyToken(token, KEYS_V1, now, "https://acme.test/_pithy/email/c/x")).resolves.toMatchObject({
      aud: PROD,
    });
    await expect(verifyToken(token, KEYS_V1, now, "http://acme.test")).rejects.toThrow();
  });

  test("a validly signed token that names no audience is refused", async () => {
    // Built by hand, because `mintToken` cannot produce one: the claim set of the scheme this replaced.
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const payload = encode(
      new TextEncoder().encode(
        JSON.stringify({ v: 1, kid: "1", exp: Math.floor(expiresAt.getTime() / 1000), ...clickClaims }),
      ),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(KEYS_V1.versions["1"]),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    await expect(verifyToken(`${payload}.${encode(signature)}`, KEYS_V1, now, PROD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });
});
