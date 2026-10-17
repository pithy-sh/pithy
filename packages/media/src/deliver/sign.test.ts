// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { deliverySigner } from "./sign";

const EXPIRES = new Date("2026-10-16T13:00:00.000Z");
const EXP = Math.floor(EXPIRES.getTime() / 1000);

/** Decode one base64url JWT segment to JSON. */
function segment(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("signImageUrl", () => {
  test("appends the expiry and an HMAC-SHA256 of the path and expiry, as Cloudflare Images verifies it", async () => {
    const signer = deliverySigner({ images: { key: "images-secret" } });
    const signed = new URL(await signer.signImageUrl("https://imagedelivery.net/hash/img-1/public", EXPIRES));

    expect(signed.origin + signed.pathname).toBe("https://imagedelivery.net/hash/img-1/public");
    expect(signed.searchParams.get("exp")).toBe(String(EXP));
    // An independent HMAC — node's, not WebCrypto — over the string Cloudflare documents.
    const expected = createHmac("sha256", "images-secret").update(`/hash/img-1/public?exp=${EXP}`).digest("hex");
    expect(signed.searchParams.get("sig")).toBe(expected);
  });

  test("a different key is a different signature", async () => {
    const a = await deliverySigner({ images: { key: "a" } }).signImageUrl("https://imagedelivery.net/h/i/v", EXPIRES);
    const b = await deliverySigner({ images: { key: "b" } }).signImageUrl("https://imagedelivery.net/h/i/v", EXPIRES);
    expect(a).not.toBe(b);
  });

  test("refuses with the provisioning command when no Images key is held", async () => {
    await expect(deliverySigner({}).signImageUrl("https://imagedelivery.net/h/i/v", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported", action: expect.stringContaining("Provision media again") },
    });
  });
});

describe("streamToken", () => {
  test("an RS256 token naming the video, the key and the expiry, verifiable with the key's public half", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const signer = deliverySigner({ stream: { keyId: "kid-1", jwk: btoa(JSON.stringify(jwk)) } });

    const token = await signer.streamToken("vid-1", EXPIRES);
    const [header, payload, signature] = token.split(".") as [string, string, string];

    expect(segment(header)).toEqual({ alg: "RS256", kid: "kid-1" });
    expect(segment(payload)).toEqual({ sub: "vid-1", kid: "kid-1", exp: EXP });
    const bytes = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      bytes,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  test("refuses when no Stream key is held", async () => {
    await expect(deliverySigner({}).streamToken("vid-1", EXPIRES)).rejects.toMatchObject({
      payload: { code: "media/unsupported" },
    });
  });
});
