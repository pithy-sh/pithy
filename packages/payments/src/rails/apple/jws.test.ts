// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { base64Url, type MintedChain, mintChain, signJws, tamperPayload } from "./fixtures/chain";
import { verifyAppleJws } from "./jws";

/**
 * The security boundary on three of the ten routes, exercised for real: a minted certificate chain, real
 * ECDSA signatures, and a verifier given only the root it should trust.
 *
 * Nothing here is stubbed, because a stub would prove only that a mock refuses when told to. Every negative
 * case below is a genuinely well-formed JWS that must not verify — the right chain with the wrong root, the
 * right signature over changed bytes, the right key with a lie in the header — and each one is a published
 * way to bypass a JWS verifier.
 */

/** One chain minted for the whole suite: key generation is the slow part, and the chain is immutable. */
let chain: MintedChain;
let roots: string[];

async function trusted(): Promise<MintedChain> {
  if (!chain) {
    chain = await mintChain();
    roots = [chain.root];
  }
  return chain;
}

const PAYLOAD = { notificationUUID: "9ad9f0d9-1a44-4f9a-9b6d-5c3a0a2e1f00", notificationType: "DID_RENEW" };

describe("verifyAppleJws", () => {
  test("verifies a JWS whose chain roots in a pinned certificate, and returns its payload", async () => {
    const jws = await signJws(PAYLOAD, await trusted());
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).resolves.toEqual(PAYLOAD);
  });

  test("rejects a payload signed by a chain that does not root in a pinned certificate", async () => {
    await trusted();
    const rogue = await mintChain({ label: "rogue" });
    // Internally flawless: real certificates, real signatures, a real chain. Only the root is not ours.
    const jws = await signJws(PAYLOAD, rogue);
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("rejects a tampered body — the signature covers the exact bytes, not the meaning", async () => {
    const jws = await signJws(PAYLOAD, await trusted());
    const tampered = tamperPayload(jws, { ...PAYLOAD, notificationType: "SUBSCRIBED" });
    expect(tampered).not.toBe(jws);
    await expect(verifyAppleJws(tampered, { roots, now: new Date() })).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("rejects a tampered header, even one that changes nothing semantic", async () => {
    const jws = await signJws(PAYLOAD, await trusted());
    const [, body, signature] = jws.split(".");
    // A re-serialized header with the same fields in a different order. The signature is over the encoded
    // header, so byte-identical is the only thing that counts.
    const header = base64Url(new TextEncoder().encode(JSON.stringify({ x5c: (await trusted()).x5c, alg: "ES256" })));
    await expect(verifyAppleJws(`${header}.${body}.${signature}`, { roots, now: new Date() })).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("rejects `alg: none` — the signature is required, not optional", async () => {
    const jws = await signJws(PAYLOAD, await trusted(), { alg: "none" });
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("rejects an unsigned JWS with an empty third segment", async () => {
    const jws = await signJws(PAYLOAD, await trusted(), { alg: "none" });
    const [head, body] = jws.split(".");
    await expect(verifyAppleJws(`${head}.${body}.`, { roots, now: new Date() })).rejects.toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("rejects algorithm confusion: an HS256 claim over the same bytes", async () => {
    // The published attack is to claim a symmetric algorithm so a verifier HMACs with the public key it
    // found in the header, and the header is attacker-controlled. `alg` is pinned to a literal, so the
    // header never parses and the key is never reached.
    const jws = await signJws(PAYLOAD, await trusted(), { alg: "HS256" });
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("rejects algorithm confusion: an RS256 claim over an EC signature", async () => {
    const jws = await signJws(PAYLOAD, await trusted(), { alg: "RS256" });
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("rejects an ES256 header over a P-384 leaf — the curve is part of the algorithm", async () => {
    // ES256 means P-256 with SHA-256. A P-384 leaf presented under ES256 is the same confusion one layer
    // down, and a verifier that only checked `alg` against the string would accept it.
    const wrongCurve = await mintChain({ label: "p384", leafCurve: "P-384" });
    const jws = await signJws(PAYLOAD, wrongCurve, {}, "SHA-384");
    await expect(verifyAppleJws(jws, { roots: [wrongCurve.root], now: new Date() })).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("rejects a missing x5c — there is nothing to chain to", async () => {
    const jws = await signJws(PAYLOAD, await trusted(), { x5c: undefined });
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("rejects an x5c that is not an array of certificates", async () => {
    const chained = await trusted();
    for (const x5c of [chained.x5c[0], [], [""], [chained.x5c[0]], 42]) {
      const jws = await signJws(PAYLOAD, chained, { x5c });
      await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
    }
  });

  test("rejects an x5c entry that is not base64 DER", async () => {
    const chained = await trusted();
    const jws = await signJws(PAYLOAD, chained, { x5c: ["!!!not base64!!!", ...chained.x5c.slice(1)] });
    await expect(verifyAppleJws(jws, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
  });

  test("rejects a JWS that is not three segments", async () => {
    for (const malformed of ["", "a", "a.b", "a.b.c.d"]) {
      await expect(verifyAppleJws(malformed, { roots, now: new Date() })).rejects.toThrow(PaymentsInvalidReceiptError);
    }
  });

  test("rejects a header that is not JSON", async () => {
    const jws = await signJws(PAYLOAD, await trusted());
    const [, body, signature] = jws.split(".");
    const header = base64Url(new TextEncoder().encode("not json"));
    await expect(verifyAppleJws(`${header}.${body}.${signature}`, { roots, now: new Date() })).rejects.toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("rejects a payload that is not JSON, after the signature verifies", async () => {
    // The signature is genuine; only the signed bytes are not JSON. Apple would never send this, and the
    // decode must still refuse rather than hand a caller something it cannot Zod-parse.
    const chained = await trusted();
    const encoder = new TextEncoder();
    const head = base64Url(encoder.encode(JSON.stringify({ alg: "ES256", x5c: chained.x5c })));
    const body = base64Url(encoder.encode("not json"));
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chained.leafKey, encoder.encode(`${head}.${body}`)),
    );
    await expect(verifyAppleJws(`${head}.${body}.${base64Url(signature)}`, { roots, now: new Date() })).rejects.toThrow(
      PaymentsInvalidReceiptError,
    );
  });

  test("rejects a JWS whose leaf certificate has expired", async () => {
    const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const expired = await mintChain({ leafNotBefore: new Date(past.getTime() - 1000), leafNotAfter: past });
    const jws = await signJws(PAYLOAD, expired);
    await expect(verifyAppleJws(jws, { roots: [expired.root], now: new Date() })).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("rejects a JWS whose leaf certificate is not yet valid", async () => {
    const future = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
    const early = await mintChain({ leafNotBefore: future, leafNotAfter: new Date(future.getTime() + 1000) });
    const jws = await signJws(PAYLOAD, early);
    await expect(verifyAppleJws(jws, { roots: [early.root], now: new Date() })).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("defaults to the pinned Apple roots when none are named", async () => {
    // The default is what production uses, so a caller that forgets `roots` must still be strict. A test
    // chain is refused precisely because Apple did not issue it.
    const jws = await signJws(PAYLOAD, await trusted());
    await expect(verifyAppleJws(jws, {})).rejects.toThrow(PaymentsVerificationFailedError);
  });
});
