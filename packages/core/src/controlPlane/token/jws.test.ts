import { beforeAll, describe, expect, test } from "vitest";
import { PithyError } from "../../error/pithyError";
import { Ed25519PublicJwk } from "../data/connection";
import { base64UrlEncode } from "./base64url";
import type { ControlPlaneClaims } from "./claims";
import { parseCompactJws, verifyEd25519 } from "./jws";

/**
 * Real keys, real signatures. A mocked verifier would prove the plumbing and nothing about the
 * cryptography, and this is the file where the cryptography is the point.
 */
let keyPair: CryptoKeyPair;
let publicJwk: Ed25519PublicJwk;
let otherKeyPair: CryptoKeyPair;
let otherPublicJwk: Ed25519PublicJwk;

async function exportPublicJwk(key: CryptoKey): Promise<Ed25519PublicJwk> {
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  // Narrowed to the three fields the seam stores, then run through the real schema. WebCrypto also
  // emits `key_ops`/`ext`/`alg`; verification must work from what the adopter's D1 row actually holds.
  return Ed25519PublicJwk.parse({ kty: "OKP", crv: "Ed25519", x: jwk.x });
}

const claims: ControlPlaneClaims = {
  iss: "https://app.pithy.sh",
  aud: "0d1f4b6e-7c2a-4f52-9c1f-2b6a5d3e8a91",
  sub: "usr_7f3c",
  scope: "manifest:read",
  jti: "01JZ8Q2M4X0000000000000000",
  iat: 1_800_000_000,
  exp: 1_800_000_030,
  bodySha256: null,
};

const header = { alg: "EdDSA", typ: "JWT", kid: "key_2026_07" } as const;

function encodeSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function sign(signingInput: string, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(signingInput));
  return base64UrlEncode(new Uint8Array(signature));
}

async function mint(overrides: { header?: unknown; claims?: unknown; privateKey?: CryptoKey } = {}): Promise<string> {
  const signingInput = `${encodeSegment(overrides.header ?? header)}.${encodeSegment(overrides.claims ?? claims)}`;
  return `${signingInput}.${await sign(signingInput, overrides.privateKey ?? keyPair.privateKey)}`;
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicJwk = await exportPublicJwk(keyPair.publicKey);
  otherPublicJwk = await exportPublicJwk(otherKeyPair.publicKey);
});

describe("parseCompactJws", () => {
  test("returns the validated header, claims, signing input and signature bytes", async () => {
    const token = await mint();
    const parsed = parseCompactJws(token);
    expect(parsed.header).toEqual(header);
    expect(parsed.claims).toEqual(claims);
    // The signing input is the first two segments verbatim — re-serializing the parsed JSON would
    // change the bytes that were actually signed and break every signature.
    expect(parsed.signingInput).toBe(token.split(".").slice(0, 2).join("."));
    expect(parsed.signature).toBeInstanceOf(Uint8Array);
    expect(parsed.signature.length).toBe(64);
  });

  test("requires exactly three segments", async () => {
    const token = await mint();
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    expect(() => parseCompactJws(`${encodedHeader}.${encodedPayload}`)).toThrow(PithyError);
    expect(() => parseCompactJws(encodedHeader ?? "")).toThrow(PithyError);
    expect(() => parseCompactJws(`${token}.${encodedSignature}`)).toThrow(PithyError);
    expect(() => parseCompactJws("")).toThrow(PithyError);
    expect(() => parseCompactJws("..")).toThrow(PithyError);
  });

  test("throws on garbage base64 in any segment", async () => {
    const token = await mint();
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    expect(() => parseCompactJws(`!!!!.${encodedPayload}.${encodedSignature}`)).toThrow(PithyError);
    expect(() => parseCompactJws(`${encodedHeader}.@@@@.${encodedSignature}`)).toThrow(PithyError);
    expect(() => parseCompactJws(`${encodedHeader}.${encodedPayload}.####`)).toThrow(PithyError);
  });

  test("throws when a segment decodes to something that is not JSON", async () => {
    const token = await mint();
    const [, encodedPayload, encodedSignature] = token.split(".");
    const notJson = base64UrlEncode(new TextEncoder().encode("{nope"));
    expect(() => parseCompactJws(`${notJson}.${encodedPayload}.${encodedSignature}`)).toThrow(PithyError);
  });

  test("validates the header through its schema — an `alg` swap never reaches verification", async () => {
    // Algorithm confusion dies at parse. `none` and HS256 are not shapes this seam can represent.
    for (const alg of ["none", "HS256", "RS256"]) {
      const token = await mint({ header: { ...header, alg } });
      expect(() => parseCompactJws(token)).toThrow(PithyError);
    }
  });

  test("validates the claims through their schema", async () => {
    const token = await mint({ claims: { ...claims, aud: "the-dashboard" } });
    expect(() => parseCompactJws(token)).toThrow(PithyError);
    const scopeless = await mint({ claims: { ...claims, scope: "manifest" } });
    expect(() => parseCompactJws(scopeless)).toThrow(PithyError);
  });

  test("every failure is one indistinguishable credential error", async () => {
    // Never an oracle. A caller learns "not valid here" and nothing about which step said so.
    try {
      parseCompactJws("two.segments");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("controlplane/invalid_credential");
      expect((error as PithyError).payload.status).toBe(401);
    }
  });
});

describe("verifyEd25519", () => {
  test("verifies a token signed by the registered key", async () => {
    const parsed = parseCompactJws(await mint());
    await expect(verifyEd25519(parsed.signingInput, parsed.signature, publicJwk)).resolves.toBe(true);
  });

  test("rejects a token signed by a different key", async () => {
    const parsed = parseCompactJws(await mint({ privateKey: otherKeyPair.privateKey }));
    await expect(verifyEd25519(parsed.signingInput, parsed.signature, publicJwk)).resolves.toBe(false);
    // ...and the same bytes do verify under the key that actually signed them, so this is a key
    // mismatch and not a broken signing helper.
    await expect(verifyEd25519(parsed.signingInput, parsed.signature, otherPublicJwk)).resolves.toBe(true);
  });

  test("rejects a tampered payload — the classic swap of a signed body for a nicer one", async () => {
    const token = await mint();
    const [encodedHeader, , encodedSignature] = token.split(".");
    const escalated = encodeSegment({ ...claims, scope: "keys:rotate" });
    const parsed = parseCompactJws(`${encodedHeader}.${escalated}.${encodedSignature}`);
    expect(parsed.claims.scope).toBe("keys:rotate"); // parse is happy — parse proves nothing
    await expect(verifyEd25519(parsed.signingInput, parsed.signature, publicJwk)).resolves.toBe(false);
  });

  test("rejects a tampered header", async () => {
    const token = await mint();
    const [, encodedPayload, encodedSignature] = token.split(".");
    const swappedKid = encodeSegment({ ...header, kid: "key_2026_08" });
    const parsed = parseCompactJws(`${swappedKid}.${encodedPayload}.${encodedSignature}`);
    await expect(verifyEd25519(parsed.signingInput, parsed.signature, publicJwk)).resolves.toBe(false);
  });

  test("rejects a tampered signature", async () => {
    const parsed = parseCompactJws(await mint());
    const flipped = Uint8Array.from(parsed.signature);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    await expect(verifyEd25519(parsed.signingInput, flipped, publicJwk)).resolves.toBe(false);
    await expect(verifyEd25519(parsed.signingInput, parsed.signature.slice(0, 63), publicJwk)).resolves.toBe(false);
    await expect(verifyEd25519(parsed.signingInput, new Uint8Array(), publicJwk)).resolves.toBe(false);
  });

  test("a malformed registered key is a denial, not a 500", async () => {
    // A bad row in the adopter's D1 must deny the call, not crash the Worker. WebCrypto throws on an
    // unimportable key; that throw is swallowed into `false`.
    const parsed = parseCompactJws(await mint());
    for (const x of ["!!!not-base64!!!", "", "QQ"]) {
      await expect(
        verifyEd25519(parsed.signingInput, parsed.signature, { kty: "OKP", crv: "Ed25519", x }),
      ).resolves.toBe(false);
    }
  });
});
