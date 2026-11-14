// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthDatabase } from "../../data/tables";
import { consumeChallenge } from "../challenge";
import { type AppleAppIdentity, testAssertionAllowedIn } from "../config";
import type { AttestationVerdict, AttestationVerifier } from "../verifier";
import { requestBinding } from "../wire";
import { verifyAppAttestAssertion } from "./assertion";
import { verifyAppAttestation } from "./attestation";
import { decodeBase64 } from "./base64";
import { advanceAppAttestCounter, findAppAttestKey, storeAppAttestKey } from "./keys";

/** The App ID App Attest hashes into `rpIdHash`: `<TeamID>.<bundleId>`. */
export function appIdOf(app: AppleAppIdentity): string {
  return `${app.teamId}.${app.bundleId}`;
}

/**
 * Whether a development key is accepted where the Worker is stamped `environment`: in dev, staging and a feature
 * deployment, as the test assertion is, and nowhere else. A production key is accepted everywhere.
 */
export function developmentKeysAllowedIn(environment: string | null): boolean {
  return testAssertionAllowedIn(environment);
}

/** A key id as `generateKey` hands it over, decoded, or `undefined` when it is not 32 bytes of base64. */
function decodeKeyId(keyId: string): Uint8Array | undefined {
  const bytes = decodeBase64(keyId);
  return bytes?.length === 32 ? bytes : undefined;
}

/** What registering a key takes. */
export interface AppAttestRegistration {
  db: AuthDatabase;
  /** The challenge the app attested over. Spent first, pass or fail. */
  challenge: string;
  /** The key id, base64, as `generateKey` hands it over. */
  keyId: string;
  /** The attestation object, base64, as `attestKey` hands it over. */
  attestation: string;
  /** The iOS apps this environment allows. */
  apps: readonly AppleAppIdentity[];
  environment: string | null;
  /** The root CA the chain must lead to, DER. */
  root: Uint8Array;
  now: Date;
}

/**
 * Register an App Attest key. The challenge is spent before anything is judged; the app attested over
 * {@link requestBinding} of the challenge and an empty body, which is SHA-256 of the challenge's characters.
 */
export async function registerAppAttestKey(input: AppAttestRegistration): Promise<AttestationVerdict> {
  const use = await consumeChallenge(input.db, input.challenge, input.now);
  if (!use.ok) return { ok: false, reason: `challenge: ${use.reason}` };
  if (input.apps.length === 0) return { ok: false, reason: "rpIdHash: no iOS app is allowed to attest here" };
  const keyId = decodeKeyId(input.keyId);
  if (keyId === undefined) return { ok: false, reason: "keyId: the key id is not 32 bytes of base64" };
  const attestation = decodeBase64(input.attestation);
  if (attestation === undefined) return { ok: false, reason: "format: the attestation object is not base64" };

  const result = await verifyAppAttestation({
    attestation,
    keyId,
    clientDataHash: await requestBinding(input.challenge, new Uint8Array(0)),
    apps: input.apps,
    allowDevelopment: developmentKeysAllowedIn(input.environment),
    root: input.root,
    now: input.now,
  });
  if (!result.ok) return { ok: false, reason: `${result.check}: ${result.reason}` };
  if (!(await storeAppAttestKey(input.db, result.key, input.now))) {
    return { ok: false, reason: "keyId: this key is already registered" };
  }
  return { ok: true };
}

/**
 * Apple App Attest. Verifies an assertion from a registered key over the request binding: the key is known, its
 * app is still allowed, the signature verifies, and the counter rises. Then stores the counter.
 */
export const appAttestVerifier: AttestationVerifier = {
  async verify({ presented, binding, environment, settings, db, now }) {
    if (presented.keyId === undefined) return { ok: false, reason: "keyId: no App Attest key id was presented" };
    const keyId = decodeKeyId(presented.keyId);
    if (keyId === undefined) return { ok: false, reason: "keyId: the key id is not 32 bytes of base64" };
    const key = await findAppAttestKey(db, keyId);
    if (key === undefined) return { ok: false, reason: "key: no App Attest key with this id is registered" };
    if (!settings.ios.some((app) => appIdOf(app) === key.appId)) {
      return { ok: false, reason: `rpIdHash: the key's app ${key.appId} is not allowed to attest here` };
    }
    if (key.environment === "development" && !developmentKeysAllowedIn(environment)) {
      return { ok: false, reason: "aaguid: a development key is refused here: only production keys are accepted" };
    }
    const assertion = decodeBase64(presented.assertion);
    if (assertion === undefined) return { ok: false, reason: "format: the assertion is not base64" };
    const publicKey = decodeBase64(key.publicKey) as Uint8Array;

    const result = await verifyAppAttestAssertion({
      assertion,
      publicKey,
      appId: key.appId,
      clientDataHash: binding,
      counter: key.counter,
    });
    if (!result.ok) return { ok: false, reason: `${result.check}: ${result.reason}` };
    if (!(await advanceAppAttestCounter(db, keyId, result.counter, now))) {
      return { ok: false, reason: `counter: ${result.counter} was overtaken by another assertion from this key` };
    }
    return { ok: true };
  },
};
