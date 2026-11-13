// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { AuthConfig } from "../capability";
import {
  AttestationConfig,
  attestationFor,
  attestationIsConfigured,
  TEST_ASSERTION_ENVIRONMENTS,
  testAssertionAllowedIn,
} from "./config";

const IOS = { teamId: "ABCDE12345", bundleId: "com.example.app" };
const ANDROID = { packageName: "com.example.app" };

describe("AttestationConfig", () => {
  test("is absent from a config that never mentions it, and configures nothing", () => {
    const config = AuthConfig.parse({ baseURL: "https://api.example.com" });
    expect(config.attestation.environments).toEqual({});
    expect(attestationIsConfigured(config.attestation)).toBe(false);
  });

  test("takes one block per environment, with the app identities and a mode", () => {
    const config = AttestationConfig.parse({
      environments: {
        staging: { mode: "test", ios: [IOS], android: [ANDROID] },
        prod: { ios: [IOS] },
      },
    });
    expect(config.environments.staging).toEqual({ mode: "test", ios: [IOS], android: [ANDROID] });
    expect(config.environments.prod).toEqual({ mode: "enforce", ios: [IOS], android: [] });
    expect(config.challengeExpiresIn).toBe(300);
    expect(attestationIsConfigured(config)).toBe(true);
  });

  test("an enforce block with no app at all is refused: no attestation could ever pass it", () => {
    expect(() => AttestationConfig.parse({ environments: { prod: { mode: "enforce" } } })).toThrow(/at least one app/);
  });

  test("a test block may name no app: the test assertion carries no identity", () => {
    expect(AttestationConfig.parse({ environments: { dev: { mode: "test" } } }).environments.dev?.mode).toBe("test");
  });

  test("an environment key no environment may carry is refused", () => {
    expect(() => AttestationConfig.parse({ environments: { production: { ios: [IOS] } } })).toThrow();
    expect(() => AttestationConfig.parse({ environments: { global: { ios: [IOS] } } })).toThrow();
  });

  test("an iOS Team ID is ten uppercase letters or digits, and a package name is a dotted Java name", () => {
    expect(() =>
      AttestationConfig.parse({ environments: { prod: { ios: [{ teamId: "abc", bundleId: "x" }] } } }),
    ).toThrow();
    expect(() =>
      AttestationConfig.parse({ environments: { prod: { android: [{ packageName: "nodots" }] } } }),
    ).toThrow();
  });

  test("the challenge lifetime is bounded to ten minutes", () => {
    expect(() => AttestationConfig.parse({ challengeExpiresIn: 601 })).toThrow();
    expect(AttestationConfig.parse({ challengeExpiresIn: 60 }).challengeExpiresIn).toBe(60);
  });
});

describe("attestationFor", () => {
  const config = AttestationConfig.parse({ environments: { staging: { mode: "test" } } });

  test("answers the block for the environment the Worker is stamped with", () => {
    expect(attestationFor(config, "staging")?.mode).toBe("test");
  });

  test("answers nothing for an environment with no block, and for an unstamped Worker", () => {
    expect(attestationFor(config, "prod")).toBeUndefined();
    expect(attestationFor(config, null)).toBeUndefined();
  });

  test("never reads a key off the prototype", () => {
    expect(attestationFor(config, "constructor")).toBeUndefined();
  });
});

describe("testAssertionAllowedIn", () => {
  test("dev, staging and a feature deployment may run test mode", () => {
    expect(TEST_ASSERTION_ENVIRONMENTS).toEqual(["dev", "staging", "feature"]);
    for (const environment of TEST_ASSERTION_ENVIRONMENTS) expect(testAssertionAllowedIn(environment)).toBe(true);
  });

  test("prod and an unstamped Worker may not", () => {
    expect(testAssertionAllowedIn("prod")).toBe(false);
    expect(testAssertionAllowedIn(null)).toBe(false);
  });

  test("nor may a declared name, which the Worker cannot tell from production", () => {
    expect(testAssertionAllowedIn("live")).toBe(false);
    expect(testAssertionAllowedIn("qa")).toBe(false);
  });
});
