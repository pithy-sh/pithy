// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { baseUrlFor, domainFor, LOCAL_ORIGIN, originFor, resolveOrigin, WorkerDomains } from "./domains";

const DOMAINS = WorkerDomains.parse({
  staging: { pattern: "staging.api.example.com", zone: "example.com" },
  prod: { pattern: "api.example.com", zone: "example.com" },
});

describe("resolveOrigin", () => {
  test("a declared environment resolves to its own https origin", () => {
    expect(resolveOrigin("prod", DOMAINS)).toEqual({
      origin: "https://api.example.com",
      hostname: "api.example.com",
      declared: true,
    });
    expect(resolveOrigin("staging", DOMAINS)).toEqual({
      origin: "https://staging.api.example.com",
      hostname: "staging.api.example.com",
      declared: true,
    });
  });

  /**
   * The load-bearing half. The shape being replaced fell back to production's origin, which is how a
   * staging deploy mails real users magic links into production. This one goes nowhere.
   */
  test("an environment with no declared domain never reaches for another environment's", () => {
    const staging = WorkerDomains.parse({ prod: { pattern: "api.example.com", zone: "example.com" } });
    expect(resolveOrigin("staging", staging)).toEqual({
      origin: LOCAL_ORIGIN,
      hostname: "localhost",
      declared: false,
    });
    expect(originFor("staging", staging)).not.toContain("api.example.com");
  });

  test("dev is never declared, and an absent declaration is the same answer", () => {
    expect(originFor("dev", DOMAINS)).toBe(LOCAL_ORIGIN);
    expect(originFor("prod", undefined)).toBe(LOCAL_ORIGIN);
  });

  /** No port, deliberately: local's port is assigned per run, so it is the one address nobody can write down. */
  test("the local origin carries no port", () => {
    expect(LOCAL_ORIGIN).toBe("http://localhost");
  });
});

/**
 * **The invariant: no config value carries an origin that a different environment would need to be
 * different.**
 *
 * Stated over the declaration rather than as a list of the fields that got it wrong — `auth.baseURL`,
 * `email.baseUrl`, the Stripe return URLs — because that list is what goes stale, and it went stale
 * three times in one Worker. What holds instead is that every published environment's origin is derived
 * from that environment's own declaration, so two of them can never be the same string unless the
 * adopter declared the same hostname twice.
 */
describe("no two published environments share an origin", () => {
  test("every declared environment derives its own", () => {
    const origins = ["staging", "prod"].map((env) => originFor(env, DOMAINS));
    expect(new Set(origins).size).toBe(origins.length);
  });

  /**
   * The planted violation: the shape an adopter writes when they type a URL instead of deriving one.
   * A literal is the same string in every environment, which is exactly what the derived form cannot be.
   */
  test("and a hardcoded origin is the thing that breaks it", () => {
    const HARDCODED = "https://api.example.com";
    const origins = ["staging", "prod"].map(() => HARDCODED);
    expect(new Set(origins).size).not.toBe(origins.length);
  });

  /** Composed from the two halves that already existed, so a caller cannot reach a third answer. */
  test("it is domainFor and baseUrlFor, and nothing else", () => {
    for (const env of ["staging", "prod"]) {
      const domain = domainFor(DOMAINS, env);
      expect(domain).not.toBeNull();
      expect(originFor(env, DOMAINS)).toBe(baseUrlFor(domain as never));
    }
  });
});
