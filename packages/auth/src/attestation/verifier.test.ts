// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuthDatabase } from "../data/tables";
import { AttestationEnvironment } from "./config";
import {
  ATTESTATION_TEST_ASSERTION,
  type AttestationVerification,
  type AttestationVerifier,
  testVerifier,
  verifierFor,
} from "./verifier";
import type { PresentedAttestation } from "./wire";

const TEST_BLOCK = AttestationEnvironment.parse({ mode: "test" });
const ENFORCE_BLOCK = AttestationEnvironment.parse({ ios: [{ teamId: "ABCDE12345", bundleId: "com.example.app" }] });

function presented(platform: "ios" | "android", assertion = ATTESTATION_TEST_ASSERTION): PresentedAttestation {
  return { platform, challenge: "c".repeat(43), assertion };
}

function verification(overrides: Partial<AttestationVerification>): AttestationVerification {
  return {
    presented: presented("ios"),
    binding: new Uint8Array(32),
    environment: "staging",
    settings: TEST_BLOCK,
    db: {} as AuthDatabase,
    env: {},
    now: new Date(),
    ...overrides,
  };
}

describe("the test verifier", () => {
  test.each(["ios", "android"] as const)(
    "accepts the test assertion from %s in a test environment",
    async (platform) => {
      expect(await testVerifier.verify(verification({ presented: presented(platform) }))).toEqual({ ok: true });
    },
  );

  test("refuses the test assertion in prod, whatever the config says", async () => {
    const verdict = await testVerifier.verify(verification({ environment: "prod" }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("ENVIRONMENT is prod") });
  });

  test("refuses it in a declared environment set to test, which the Worker cannot tell from production", async () => {
    const verdict = await testVerifier.verify(verification({ environment: "live" }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("dev, staging or feature") });
  });

  test("refuses it in an unstamped Worker, which cannot show it is not production", async () => {
    expect((await testVerifier.verify(verification({ environment: null }))).ok).toBe(false);
  });

  test("refuses it in an environment set to enforce", async () => {
    const verdict = await testVerifier.verify(verification({ settings: ENFORCE_BLOCK }));
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("enforce") });
  });

  test("refuses anything that is not the test assertion", async () => {
    expect((await testVerifier.verify(verification({ presented: presented("ios", "real-looking") }))).ok).toBe(false);
  });
});

describe("verifierFor", () => {
  const ios: AttestationVerifier = { verify: async () => ({ ok: true }) };

  test("hands the test assertion to the test verifier, on either platform", () => {
    expect(verifierFor(presented("ios"), { ios })).toBe(testVerifier);
    expect(verifierFor(presented("android"), {})).toBe(testVerifier);
  });

  test("hands any other assertion to its platform's verifier", () => {
    expect(verifierFor(presented("ios", "real"), { ios })).toBe(ios);
  });

  test("answers nothing for a platform with no verifier", () => {
    expect(verifierFor(presented("android", "real"), { ios })).toBeUndefined();
  });
});
