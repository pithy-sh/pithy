// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { APPLE_SAMPLE } from "../../test-utils/appAttestSample";
import { decodeBase64 } from "./base64";
import { cborBytes, decodeCbor } from "./cbor";
import { DerError } from "./der";
import { APPLE_APP_ATTESTATION_ROOT } from "./root";
import { type Certificate, derSignatureToRaw, parseCertificate, verifyChain, verifyEcdsa } from "./x509";

/** The leaf and intermediate from Apple's sample attestation. */
function sampleChain(): Certificate[] {
  const object = decodeCbor(decodeBase64(APPLE_SAMPLE.attestation) as Uint8Array);
  const statement = object instanceof Map ? object.get("attStmt") : undefined;
  const x5c = statement instanceof Map ? (statement.get("x5c") as Uint8Array[]) : [];
  expect(cborBytes(object, "authData")).toBeDefined();
  return x5c.map(parseCertificate);
}

const ROOT = parseCertificate(APPLE_APP_ATTESTATION_ROOT);

describe("parseCertificate", () => {
  test("reads the sample's leaf: a P-256 key, signed with SHA-256, carrying the nonce extension", () => {
    const [leaf] = sampleChain();
    expect(leaf?.publicKey.curve).toBe("P-256");
    expect(leaf?.publicKey.point).toHaveLength(65);
    expect(leaf?.hash).toBe("SHA-256");
    expect(leaf?.isCA).toBe(false);
    expect(leaf?.extensions.has("1.2.840.113635.100.8.2")).toBe(true);
    expect(leaf?.notBefore).toEqual(new Date("2026-04-20T18:13:12Z"));
    expect(leaf?.notAfter).toEqual(new Date("2026-04-23T18:13:12Z"));
  });

  test("reads the sample's intermediate as a P-384 CA the root issued", () => {
    const [, intermediate] = sampleChain();
    expect(intermediate?.isCA).toBe(true);
    expect(intermediate?.publicKey.curve).toBe("P-384");
    expect(intermediate?.issuer).toEqual(ROOT.subject);
  });

  test("refuses bytes that are not a certificate", () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x00]))).toThrow(DerError);
    expect(() => parseCertificate(new Uint8Array([0x04, 0x01, 0x00]))).toThrow(DerError);
  });
});

describe("derSignatureToRaw", () => {
  test("strips the sign byte DER adds to an integer with its high bit set, and pads a short one", () => {
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x01, 0x05]);
    const raw = derSignatureToRaw(der, "P-256");
    expect(raw).toHaveLength(64);
    expect(raw?.subarray(30, 32)).toEqual(new Uint8Array([0x80, 0x01]));
    expect(raw?.[63]).toBe(5);
    expect(raw?.subarray(0, 30).every((byte) => byte === 0)).toBe(true);
  });

  test("refuses a negative integer, an integer wider than the field, and a third element", () => {
    expect(
      derSignatureToRaw(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01]), "P-256"),
    ).toBeUndefined();
    const wide = new Uint8Array([0x30, 0x25, 0x02, 0x21, 0x01, ...new Array(32).fill(1), 0x02, 0x00]);
    expect(derSignatureToRaw(wide, "P-256")).toBeUndefined();
    expect(
      derSignatureToRaw(new Uint8Array([0x30, 0x09, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), "P-256"),
    ).toBeUndefined();
    expect(derSignatureToRaw(new Uint8Array([0x05, 0x00]), "P-256")).toBeUndefined();
  });
});

describe("verifyEcdsa", () => {
  test("answers false, not a throw, for a point that is not on the curve", async () => {
    const point = new Uint8Array(65).fill(1);
    point[0] = 4;
    const signature = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    expect(await verifyEcdsa({ curve: "P-256", point }, "SHA-256", signature, new Uint8Array(1))).toBe(false);
  });
});

describe("verifyChain", () => {
  test("accepts the sample's chain under Apple's root while its leaf is valid", async () => {
    expect(await verifyChain(sampleChain(), ROOT, APPLE_SAMPLE.at)).toEqual({ ok: true });
  });

  test("refuses it once the leaf has expired, and before it was issued", async () => {
    expect(await verifyChain(sampleChain(), ROOT, new Date("2026-04-23T18:13:13Z"))).toMatchObject({ ok: false });
    expect(await verifyChain(sampleChain(), ROOT, new Date("2026-04-20T18:13:11Z"))).toMatchObject({ ok: false });
  });

  test("refuses a chain in the wrong order", async () => {
    const [leaf, intermediate] = sampleChain() as [Certificate, Certificate];
    expect(await verifyChain([intermediate, leaf], ROOT, APPLE_SAMPLE.at)).toMatchObject({ ok: false });
  });

  test("refuses a leaf whose signature was tampered with", async () => {
    const [leaf, intermediate] = sampleChain() as [Certificate, Certificate];
    const signature = leaf.signature.slice();
    signature[signature.length - 1] = (signature[signature.length - 1] as number) ^ 1;
    expect(await verifyChain([{ ...leaf, signature }, intermediate], ROOT, APPLE_SAMPLE.at)).toEqual({
      ok: false,
      reason: "the leaf certificate is not signed by its issuer",
    });
  });

  test("refuses an issuer that is not a CA", async () => {
    const [leaf, intermediate] = sampleChain() as [Certificate, Certificate];
    expect(await verifyChain([leaf, { ...intermediate, isCA: false }], ROOT, APPLE_SAMPLE.at)).toEqual({
      ok: false,
      reason: "the issuer of the leaf certificate is not a CA",
    });
  });

  test("refuses an empty chain", async () => {
    expect(await verifyChain([], ROOT, APPLE_SAMPLE.at)).toMatchObject({ ok: false });
  });
});
