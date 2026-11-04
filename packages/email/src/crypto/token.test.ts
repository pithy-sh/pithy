// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodingsHolding } from "@pithy-sh/core/src/test-utils/urlDecodings";
import { describe, expect, test } from "vitest";
import { mintToken, type TokenClaims, tokenAudience, verifyToken } from "./token";

/**
 * A token in the signed `<payload>.<signature>` format, built the way mail already in inboxes carries it.
 *
 * Only tests build one: `mintToken` seals, and the verifier reads this format until the last such link expires. The
 * payload is plain base64url JSON, recipient included, which is exactly why nothing mints it any more.
 */
async function signedToken(
  claims: TokenClaims,
  options: { key: string; kid: string; expiresAt: Date; audience: string; v?: number },
): Promise<string> {
  const encode = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const payload = encode(
    new TextEncoder().encode(
      JSON.stringify({
        ...claims,
        v: options.v ?? 2,
        kid: options.kid,
        ...(options.v === 1 ? {} : { aud: tokenAudience(options.audience) }),
        exp: Math.floor(options.expiresAt.getTime() / 1000),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${encode(signature)}`;
}

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

/**
 * **A link carries no address anyone holding it can read.** The token is written to every request log between a mail
 * client and the Worker, so the test decodes it the way a reader of that log could: raw, URL-decoded, and every
 * segment as base64 and base64url.
 */
describe("what a token gives away", () => {
  test("a minted token decodes, in no way, to its recipient or any other claim", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    for (const secret of [clickClaims.recipient, clickClaims.destination, clickClaims.jobId, "spring", "acme.test"]) {
      expect(decodingsHolding(`${AUD}/_pithy/email/c/${token}`.replace(AUD, ""), secret)).toEqual([]);
    }
  });

  test("the signed format it replaced decodes to its recipient, which is what the gate catches", async () => {
    const token = await signedToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    expect(decodingsHolding(`/_pithy/email/c/${token}`, clickClaims.recipient)).not.toEqual([]);
  });

  test("nothing mints the signed format: every token is sealed", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    expect(token.split(".")).toHaveLength(3);
    expect(token.startsWith("3.")).toBe(true);
  });

  test("two tokens for the same claims share no ciphertext", async () => {
    const options = { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD };
    expect(await mintToken(clickClaims, options)).not.toBe(await mintToken(clickClaims, options));
  });
});

/**
 * **A link already in an inbox keeps working until it expires.** Mail cannot be recalled, so the signed format is
 * still read, under the same key, audience and expiry rules, and only until its own `exp`.
 */
describe("a token in the signed format", () => {
  test("still verifies to its claims", async () => {
    const token = await signedToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    await expect(verifyToken(token, KEYS_V1, now, AUD)).resolves.toMatchObject({ ...clickClaims, v: 2 });
  });

  test("is refused once it expires", async () => {
    const token = await signedToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    await expect(verifyToken(token, KEYS_V1, new Date("2026-09-19T00:00:00.000Z"), AUD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });

  test("is refused with a tampered payload, a wrong key or another origin", async () => {
    const token = await signedToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const [payload, signature] = token.split(".");
    await expect(verifyToken(`${payload}x.${signature}`, KEYS_V1, now, AUD)).rejects.toThrow();
    await expect(verifyToken(`${payload}.AAAA`, KEYS_V1, now, AUD)).rejects.toThrow();
    const forged = await signedToken(clickClaims, { key: "an-attacker-key", kid: "1", expiresAt, audience: AUD });
    await expect(verifyToken(forged, KEYS_V1, now, AUD)).rejects.toThrow();
    await expect(verifyToken(token, KEYS_V1, now, "https://staging.acme.test")).rejects.toThrow();
  });

  test.each(["__proto__", "constructor"])("is refused with a prototype-chain kid (%s)", async (kid) => {
    const forgeKey = kid === "__proto__" ? "[object Object]" : String(({} as Record<string, unknown>)[kid]);
    const token = await signedToken(clickClaims, { key: forgeKey, kid, expiresAt, audience: AUD });
    await expect(verifyToken(token, KEYS_V1, now, AUD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });
});

describe("callback token mint/verify", () => {
  test("a minted token round-trips to its claims", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const claims = await verifyToken(token, KEYS_V1, now, AUD);
    expect(claims).toMatchObject(clickClaims);
    expect(claims.kid).toBe("1");
  });

  test("a tampered ciphertext is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt, audience: AUD });
    const [prefix, kid, sealed = ""] = token.split(".");
    const flipped = `${sealed.slice(0, 20)}${sealed[20] === "A" ? "B" : "A"}${sealed.slice(21)}`;
    await expect(verifyToken(`${prefix}.${kid}.${flipped}`, KEYS_V1, now, AUD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });

  test("a token moved to another key version is rejected", async () => {
    const shared = { currentVersion: "2", versions: { "1": "same-secret", "2": "same-secret" } };
    const token = await mintToken(clickClaims, { key: "same-secret", kid: "1", expiresAt, audience: AUD });
    const [prefix, , sealed] = token.split(".");
    const moved = `${prefix}.${btoa("2").replace(/=+$/, "")}.${sealed}`;
    await expect(verifyToken(moved, shared, now, AUD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
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
    const token = await signedToken(clickClaims, {
      key: KEYS_V1.versions["1"],
      kid: "1",
      expiresAt,
      audience: PROD,
      v: 1,
    });
    await expect(verifyToken(token, KEYS_V1, now, PROD)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });
});
