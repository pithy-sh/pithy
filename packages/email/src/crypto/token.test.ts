import { describe, expect, test } from "vitest";
import { mintToken, verifyToken } from "./token";

const KEYS_V1 = { currentVersion: "1", versions: { "1": "super-secret-signing-key-one" } };
const KEYS_V2 = {
  currentVersion: "2",
  versions: { "1": "super-secret-signing-key-one", "2": "super-secret-signing-key-two" },
};
const KEYS_V2_ONLY = { currentVersion: "2", versions: { "2": "super-secret-signing-key-two" } };

const now = new Date("2026-06-18T00:00:00.000Z");
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
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    const claims = await verifyToken(token, KEYS_V1, now);
    expect(claims).toMatchObject(clickClaims);
    expect(claims.kid).toBe("1");
  });

  test("a tampered payload is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    const [payloadB64, sig] = token.split(".");
    const forged = `${payloadB64}x.${sig}`;
    await expect(verifyToken(forged, KEYS_V1, now)).rejects.toThrow();
  });

  test("a tampered signature is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    const [payloadB64] = token.split(".");
    await expect(verifyToken(`${payloadB64}.AAAA`, KEYS_V1, now)).rejects.toThrow();
  });

  test("a malformed token (no signature segment) is rejected", async () => {
    await expect(verifyToken("not-a-token", KEYS_V1, now)).rejects.toThrow();
  });

  test("an expired token is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    const afterExpiry = new Date("2026-09-19T00:00:00.000Z");
    await expect(verifyToken(token, KEYS_V1, afterExpiry)).rejects.toThrow();
  });

  test("a token signed under an old kid still verifies while that version is retained", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    // Rotation happened: current is now v2, but v1 is still in the valid set.
    const claims = await verifyToken(token, KEYS_V2, now);
    expect(claims.jobId).toBe("job-1");
  });

  test("a token whose kid has been pruned from the valid set is rejected", async () => {
    const token = await mintToken(clickClaims, { key: KEYS_V1.versions["1"], kid: "1", expiresAt });
    await expect(verifyToken(token, KEYS_V2_ONLY, now)).rejects.toThrow();
  });

  test("a token signed with the wrong key for its kid is rejected", async () => {
    // Same kid "1" but the verifier holds a different secret for version 1.
    const token = await mintToken(clickClaims, { key: "an-attacker-key", kid: "1", expiresAt });
    await expect(verifyToken(token, KEYS_V1, now)).rejects.toThrow();
  });

  // A `kid` that walks the prototype chain (`__proto__`, `constructor`) must not resolve to a usable
  // key — otherwise an attacker forges tokens against the coerced `"[object Object]"` / Object source.
  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "a prototype-chain kid (%s) is rejected, not used as a key",
    async (kid) => {
      const forgeKey = kid === "__proto__" ? "[object Object]" : String(({} as Record<string, unknown>)[kid]);
      const token = await mintToken(clickClaims, { key: forgeKey, kid, expiresAt });
      await expect(verifyToken(token, KEYS_V1, now)).rejects.toMatchObject({
        payload: { code: "email/invalid_token" },
      });
    },
  );
});
