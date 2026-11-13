// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthDatabase } from "../data/tables";
import { type AttestationEnvironment, type AttestationPlatform, testAssertionAllowedIn } from "./config";
import type { PresentedAttestation } from "./wire";

/**
 * The documented test assertion. In dev, staging or a feature deployment set to `test`, the gate accepts it from
 * either platform in place of a real one, so simulators, emulators and CI get through.
 */
export const ATTESTATION_TEST_ASSERTION = "pithy-test-attestation";

/** Everything a verifier is handed for one attestation. The challenge is already spent and was live. */
export interface AttestationVerification {
  /** The decoded header. */
  presented: PresentedAttestation;
  /** {@link import("./wire").requestBinding} for this request: what the assertion must be made over. */
  binding: Uint8Array;
  /** The environment the Worker is stamped with, or `null` for an unstamped Worker. */
  environment: string | null;
  /** This environment's attestation block: the apps allowed to attest, and the mode. */
  settings: AttestationEnvironment;
  /** Auth's database, for a verifier that keeps state of its own, such as App Attest's registered keys. */
  db: AuthDatabase;
  /**
   * The Worker's bindings, for a verifier that needs a credential: it reads its secret from auth's registry with
   * `sharedSecretsStore(env, authSecretsRegistry)`, as Turnstile reads its own, and answers a missing or unusable
   * one with `auth/attestation_config`.
   */
  env: Readonly<Record<string, unknown>>;
  /** The instant the request is judged at. */
  now: Date;
}

/** A verifier's answer. `reason` says why, for the refusal's `detail`; it never reaches the client. */
export type AttestationVerdict = { ok: true } | { ok: false; reason: string };

/**
 * One platform's verification. A verdict about the attestation is answered; a fault in the server's own setup is
 * thrown as `auth/attestation_config`. Runs on WebCrypto alone.
 */
export interface AttestationVerifier {
  verify(verification: AttestationVerification): Promise<AttestationVerdict>;
}

/** The verifier for each platform. A platform with none answers `auth/attestation_config` for a real assertion. */
export type AttestationVerifiers = Partial<Record<AttestationPlatform, AttestationVerifier>>;

/** The verifiers this release ships for real assertions. */
export const PLATFORM_VERIFIERS: AttestationVerifiers = {};

/** Whether this attestation is the documented test assertion. */
export function isTestAssertion(presented: PresentedAttestation): boolean {
  return presented.assertion === ATTESTATION_TEST_ASSERTION;
}

/**
 * Accepts {@link ATTESTATION_TEST_ASSERTION} from either platform, only where the environment is set to `test` and
 * the Worker's own stamp is one of {@link import("./config").TEST_ASSERTION_ENVIRONMENTS}, so no config can open
 * it anywhere else.
 */
export const testVerifier: AttestationVerifier = {
  async verify({ presented, environment, settings }) {
    if (!isTestAssertion(presented)) return { ok: false, reason: "not the test assertion" };
    if (!testAssertionAllowedIn(environment)) {
      return {
        ok: false,
        reason: `the test assertion is refused where ENVIRONMENT is ${environment ?? "unstamped"}, whatever the config says: only dev, staging or feature accept it`,
      };
    }
    if (settings.mode !== "test") {
      return { ok: false, reason: `the test assertion is refused in ${environment}, which is set to enforce` };
    }
    return { ok: true };
  },
};

/** The verifier an attestation goes to: the test verifier for the test assertion, otherwise its platform's. */
export function verifierFor(
  presented: PresentedAttestation,
  verifiers: AttestationVerifiers,
): AttestationVerifier | undefined {
  return isTestAssertion(presented) ? testVerifier : verifiers[presented.platform];
}
