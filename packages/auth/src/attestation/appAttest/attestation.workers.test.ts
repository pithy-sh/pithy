// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { appAttestAuthority } from "../../test-utils/appAttestDevice";
import { APPLE_SAMPLE } from "../../test-utils/appAttestSample";
import { type AppAttestationInput, verifyAppAttestation } from "./attestation";
import { decodeBase64 } from "./base64";
import { APPLE_APP_ATTESTATION_ROOT } from "./root";

const bytes = (base64: string) => decodeBase64(base64) as Uint8Array;
const APP = { teamId: "ABCDE12345", bundleId: "com.example.app" };
const APP_ID = `${APP.teamId}.${APP.bundleId}`;
const CLIENT_DATA_HASH = new Uint8Array(32).fill(7);

describe("Apple's published sample attestation", () => {
  const input: AppAttestationInput = {
    attestation: bytes(APPLE_SAMPLE.attestation),
    keyId: bytes(APPLE_SAMPLE.keyId),
    clientDataHash: APPLE_SAMPLE.clientDataHash,
    apps: [APPLE_SAMPLE.app],
    allowDevelopment: false,
    root: APPLE_APP_ATTESTATION_ROOT,
    now: APPLE_SAMPLE.at,
  };

  test("verifies against the pinned Apple root, and yields the key", async () => {
    const result = await verifyAppAttestation(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key.appId).toBe("1234567890.com.example.myapp");
    expect(result.key.environment).toBe("production");
    expect(result.key.publicKey).toHaveLength(65);
    expect(new Uint8Array(await crypto.subtle.digest("SHA-256", result.key.publicKey))).toEqual(input.keyId);
  });

  test("is refused once its leaf certificate has expired", async () => {
    const result = await verifyAppAttestation({ ...input, now: new Date("2026-04-24T00:00:00Z") });
    expect(result).toEqual({ ok: false, check: "chain", reason: expect.stringContaining("not valid at") });
  });

  test("is refused for another challenge", async () => {
    const result = await verifyAppAttestation({
      ...input,
      clientDataHash: new TextEncoder().encode("another_server_challenge"),
    });
    expect(result).toMatchObject({ ok: false, check: "nonce" });
  });

  test("is refused for an app it was not made for", async () => {
    const result = await verifyAppAttestation({
      ...input,
      apps: [{ ...APPLE_SAMPLE.app, bundleId: "com.example.other" }],
    });
    expect(result).toMatchObject({ ok: false, check: "rpIdHash" });
  });

  test("is refused under a root other than Apple's", async () => {
    const authority = await appAttestAuthority({ now: APPLE_SAMPLE.at });
    expect(await verifyAppAttestation({ ...input, root: authority.root })).toMatchObject({ ok: false, check: "chain" });
  });

  test("is refused for a key id it does not carry", async () => {
    expect(await verifyAppAttestation({ ...input, keyId: new Uint8Array(32) })).toMatchObject({
      ok: false,
      check: "keyId",
    });
  });
});

describe("verifyAppAttestation", () => {
  async function attested(
    overrides: Parameters<Awaited<ReturnType<typeof appAttestAuthority>>["attest"]>[0] | object = {},
  ) {
    const authority = await appAttestAuthority();
    const key = await authority.attest({ appId: APP_ID, clientDataHash: CLIENT_DATA_HASH, ...overrides });
    const input: AppAttestationInput = {
      attestation: bytes(key.attestation),
      keyId: bytes(key.keyId),
      clientDataHash: CLIENT_DATA_HASH,
      apps: [APP],
      allowDevelopment: false,
      root: authority.root,
      now: new Date(),
    };
    return { authority, key, input };
  }

  test("verifies a well-formed attestation under the root it chains to", async () => {
    const { key, input } = await attested();
    const result = await verifyAppAttestation(input);
    expect(result).toEqual({
      ok: true,
      key: { keyId: input.keyId, publicKey: key.publicKey, appId: APP_ID, environment: "production" },
    });
  });

  test("checks the rpIdHash against every allowed app, not only the first", async () => {
    const { input } = await attested();
    const result = await verifyAppAttestation({ ...input, apps: [{ teamId: "ZZZZZ99999", bundleId: "x" }, APP] });
    expect(result.ok).toBe(true);
  });

  test("refuses a wrong chain: a leaf from another authority", async () => {
    const { input } = await attested();
    const other = await appAttestAuthority();
    expect(await verifyAppAttestation({ ...input, root: other.root })).toMatchObject({
      ok: false,
      check: "chain",
      reason: expect.stringContaining("signed by its issuer"),
    });
  });

  test("refuses a wrong rpIdHash", async () => {
    const { input } = await attested({ appId: "ABCDE12345.com.example.impostor" });
    expect(await verifyAppAttestation(input)).toMatchObject({ ok: false, check: "rpIdHash" });
  });

  test("refuses a nonce that is not bound to the challenge", async () => {
    const { input } = await attested({ nonce: new Uint8Array(32).fill(1) });
    expect(await verifyAppAttestation(input)).toMatchObject({ ok: false, check: "nonce" });
  });

  test("refuses a development AAGUID where development is not allowed", async () => {
    const { input } = await attested({ environment: "development" });
    expect(await verifyAppAttestation(input)).toMatchObject({
      ok: false,
      check: "aaguid",
      reason: expect.stringContaining("development"),
    });
  });

  test("accepts a development AAGUID where development is allowed, and says so", async () => {
    const { input } = await attested({ environment: "development" });
    const result = await verifyAppAttestation({ ...input, allowDevelopment: true });
    expect(result.ok && result.key.environment).toBe("development");
  });

  test("refuses a counter other than zero", async () => {
    const { input } = await attested({ counter: 1 });
    expect(await verifyAppAttestation(input)).toMatchObject({ ok: false, check: "counter" });
  });

  test("refuses a credential id other than the key id", async () => {
    const { input } = await attested({ credentialId: new Uint8Array(32).fill(9) });
    expect(await verifyAppAttestation(input)).toMatchObject({ ok: false, check: "credentialId" });
  });

  test("refuses a leaf that is not yet valid", async () => {
    const { input } = await attested({ notBefore: new Date(Date.now() + 60_000) });
    expect(await verifyAppAttestation(input)).toMatchObject({ ok: false, check: "chain" });
  });

  test.each([
    ["not CBOR", new Uint8Array([0xff])],
    ["CBOR of the wrong shape", new Uint8Array([0xa0])],
  ])("refuses an attestation object that is %s", async (_, attestation) => {
    const { input } = await attested();
    expect(await verifyAppAttestation({ ...input, attestation })).toMatchObject({ ok: false, check: "format" });
  });
});
