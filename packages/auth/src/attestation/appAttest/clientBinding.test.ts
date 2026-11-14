// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuthFetch } from "../../client/api";
import {
  appAttestAttester,
  ATTESTATION_HEADER as CLIENT_HEADER,
  ATTESTATION_TEST_ASSERTION as CLIENT_TEST_ASSERTION,
  createAttestation,
} from "../../client/attestation";
import type { SecureStore } from "../../client/bearer";
import { appAttestAuthority, appAttestDeviceModule } from "../../test-utils/appAttestDevice";
import { ATTESTATION_TEST_ASSERTION } from "../verifier";
import { ATTESTATION_HEADER, decodeAttestation, requestBinding } from "../wire";
import { verifyAppAttestAssertion } from "./assertion";
import { verifyAppAttestation } from "./attestation";
import { decodeBase64 } from "./base64";

/**
 * The client's App Attest calls against this verifier, byte for byte: what `appAttestAttester` hands the module to
 * register a key and to assert is what `registerAppAttestKey` and `appAttestVerifier` check. Here, rather than beside
 * the client, because the client's own program compiles without the server's types.
 */

const ORIGIN = "https://api.example.test";

function memoryStore(): SecureStore {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    deleteItem: async (key) => {
      data.delete(key);
    },
  };
}

function header(result: Awaited<ReturnType<ReturnType<typeof createAttestation>["attest"]>>): string {
  if (!result.ok) throw new Error(`expected a header, got ${result.failure.code}`);
  return result.value[ATTESTATION_HEADER] ?? "";
}

describe("the client speaks the gate's wire", () => {
  test("the header and the test assertion are the ones the Worker reads", () => {
    expect(CLIENT_HEADER).toBe(ATTESTATION_HEADER);
    expect(CLIENT_TEST_ASSERTION).toBe(ATTESTATION_TEST_ASSERTION);
  });
});

describe("App Attest's bindings are the ones the Worker verifies", () => {
  const APP_ID = "ABCDE12345.com.example.app";

  test("registration and each assertion verify against the merged verifier, byte for byte", async () => {
    const authority = await appAttestAuthority();
    const device = appAttestDeviceModule(authority, APP_ID);
    const registrations: { challenge: string; keyId: string; attestation: string }[] = [];
    let issued = 0;
    const fetch: AuthFetch = async (url, init) => {
      if (url.endsWith("/attestation/challenge")) {
        issued += 1;
        return { ok: true, status: 200, json: async () => ({ challenge: `challenge-${issued}`, expiresAt: "x" }) };
      }
      const registration = JSON.parse(String(init?.body)) as (typeof registrations)[number];
      registrations.push(registration);
      return { ok: true, status: 200, json: async () => ({ keyId: registration.keyId, registeredAt: "x" }) };
    };
    const attestation = createAttestation({
      origin: ORIGIN,
      fetch,
      attester: appAttestAttester({ module: device, store: memoryStore() }),
    });
    // An address beyond ASCII, so the body's bytes are UTF-8 on both sides.
    const bodies = [JSON.stringify({ email: "zoë@example.com", type: "sign-in" }), JSON.stringify({ email: "a@b.c" })];
    const headers = [];
    for (const body of bodies) headers.push(header(await attestation.attest(body)));

    expect(registrations).toHaveLength(1);
    const registration = registrations[0] as (typeof registrations)[number];
    const attested = await verifyAppAttestation({
      attestation: decodeBase64(registration.attestation) as Uint8Array,
      keyId: decodeBase64(registration.keyId) as Uint8Array,
      clientDataHash: await requestBinding(registration.challenge, new Uint8Array(0)),
      apps: [{ teamId: "ABCDE12345", bundleId: "com.example.app" }],
      allowDevelopment: false,
      root: authority.root,
      now: new Date(),
    });
    expect(attested.ok ? "verified" : `${attested.check}: ${attested.reason}`).toBe("verified");
    if (!attested.ok) return;

    let counter = 0;
    for (const [index, body] of bodies.entries()) {
      const decoded = decodeAttestation(headers[index] as string);
      if (!decoded.ok) throw new Error("the header does not decode");
      expect(decoded.value.keyId).toBe(registration.keyId);
      const verdict = await verifyAppAttestAssertion({
        assertion: decodeBase64(decoded.value.assertion) as Uint8Array,
        publicKey: attested.key.publicKey,
        appId: APP_ID,
        clientDataHash: await requestBinding(decoded.value.challenge, new TextEncoder().encode(body)),
        counter,
      });
      expect(verdict.ok ? "verified" : `${verdict.check}: ${verdict.reason}`).toBe("verified");
      if (verdict.ok) counter = verdict.counter;
    }
    expect(counter).toBe(2);
  });
});
