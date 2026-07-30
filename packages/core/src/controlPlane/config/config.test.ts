// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ControlPlaneConfig } from "./config";

describe("ControlPlaneConfig", () => {
  test("an empty config parses to the shipped defaults", () => {
    expect(ControlPlaneConfig.parse({})).toEqual({
      basePath: "/control-plane",
      issuer: "https://app.pithy.sh",
      clockSkewSeconds: 60,
      maxTokenLifetimeSeconds: 60,
      jtiTtlSeconds: 300,
      keyRetentionDays: 30,
      maxKeys: 8,
    });
  });

  test("the defaults leave replay memory outliving the widest token they accept", () => {
    // Two skews, not one: a token is accepted a skew before its `iat` and a skew after its `exp`.
    const config = ControlPlaneConfig.parse({});
    expect(config.jtiTtlSeconds).toBeGreaterThan(config.maxTokenLifetimeSeconds + 2 * config.clockSkewSeconds);
  });

  describe("the replay window", () => {
    // The misconfiguration this rule exists for: a `jti` forgotten while the token that carried it is
    // still inside its acceptance window is a token that can be replayed.
    test("rejects a jti ttl shorter than a token's widest acceptance window", () => {
      const result = ControlPlaneConfig.safeParse({
        clockSkewSeconds: 60,
        maxTokenLifetimeSeconds: 120,
        jtiTtlSeconds: 120,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["jtiTtlSeconds"]);
    });

    test("counts the clock skew at BOTH ends of the window", () => {
      // Skew 30 + lifetime 60 means a token is accepted from 30s before its `iat` until 30s after its
      // `exp` — 120 seconds, not 90. The rule counted one skew for a while, and every pair in between
      // parsed cleanly while still leaving a replay window open. 91 is such a pair.
      expect(
        ControlPlaneConfig.safeParse({ clockSkewSeconds: 30, maxTokenLifetimeSeconds: 60, jtiTtlSeconds: 91 }).success,
      ).toBe(false);
    });

    test("rejects a jti ttl exactly equal to that window — the boundary is a replay, not a near miss", () => {
      expect(
        ControlPlaneConfig.safeParse({ clockSkewSeconds: 30, maxTokenLifetimeSeconds: 60, jtiTtlSeconds: 120 }).success,
      ).toBe(false);
    });

    test("accepts a jti ttl one second past the window", () => {
      const config = ControlPlaneConfig.parse({
        clockSkewSeconds: 30,
        maxTokenLifetimeSeconds: 60,
        jtiTtlSeconds: 121,
      });
      expect(config.jtiTtlSeconds).toBe(121);
    });

    test("widening skew alone can invalidate an otherwise fine pair", () => {
      expect(ControlPlaneConfig.safeParse({ clockSkewSeconds: 300, jtiTtlSeconds: 180 }).success).toBe(false);
    });
  });

  describe("bounds", () => {
    test.each([
      ["a negative clock skew", { clockSkewSeconds: -1 }],
      ["a clock skew past the ceiling", { clockSkewSeconds: 301 }],
      ["a fractional clock skew", { clockSkewSeconds: 1.5 }],
      ["a zero token lifetime", { maxTokenLifetimeSeconds: 0 }],
      ["a token lifetime past the ceiling", { maxTokenLifetimeSeconds: 301, jtiTtlSeconds: 3600 }],
      ["a zero jti ttl", { jtiTtlSeconds: 0 }],
      ["a jti ttl past the ceiling", { jtiTtlSeconds: 3601 }],
      ["a zero key retention", { keyRetentionDays: 0 }],
      ["a key retention past the ceiling", { keyRetentionDays: 366 }],
      ["a single-key ceiling, which forbids a rotation overlap", { maxKeys: 1 }],
      ["a key ceiling past the bound", { maxKeys: 33 }],
    ])("rejects %s", (_label, input) => {
      expect(ControlPlaneConfig.safeParse(input).success).toBe(false);
    });

    test("accepts the widest coherent settings", () => {
      const config = ControlPlaneConfig.parse({
        clockSkewSeconds: 300,
        maxTokenLifetimeSeconds: 300,
        jtiTtlSeconds: 3600,
        keyRetentionDays: 365,
        maxKeys: 32,
      });
      expect(config.maxKeys).toBe(32);
    });
  });

  describe("basePath", () => {
    test("accepts a rooted path", () => {
      expect(ControlPlaneConfig.parse({ basePath: "/admin/control-plane" }).basePath).toBe("/admin/control-plane");
    });

    test.each([["control-plane"], ["/control-plane/"], [""], ["/control plane"]])("rejects %j", (basePath) => {
      expect(ControlPlaneConfig.safeParse({ basePath }).success).toBe(false);
    });
  });

  describe("issuer", () => {
    test("accepts another management-client origin", () => {
      expect(ControlPlaneConfig.parse({ issuer: "https://dashboard.example.com" }).issuer).toBe(
        "https://dashboard.example.com",
      );
    });

    test("rejects a value that is not a URL", () => {
      expect(ControlPlaneConfig.safeParse({ issuer: "app.pithy.sh" }).success).toBe(false);
    });
  });
});
