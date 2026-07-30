// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type FeatureIdentity, type FeatureResourceKind, featureResourceName, MAX_RESOURCE_NAME } from "./naming";

const KINDS: FeatureResourceKind[] = ["d1", "kv", "r2"];
const VALID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("featureResourceName", () => {
  const base: FeatureIdentity = { project: "acme", issue: "69", slug: "media-cli" };

  test("composes <project>-f<issue>-<slug>-<binding>-<kind>, kebabing the binding", () => {
    expect(featureResourceName(base, "ASSETS", "r2")).toBe("acme-f69-media-cli-assets-r2");
    expect(featureResourceName(base, "MY_DB", "d1")).toBe("acme-f69-media-cli-my-db-d1");
  });

  test("is deterministic and unique per binding + kind", () => {
    expect(featureResourceName(base, "DB", "d1")).toBe(featureResourceName(base, "DB", "d1"));
    const names = new Set([
      featureResourceName(base, "DB", "d1"),
      featureResourceName(base, "CACHE", "kv"),
      featureResourceName(base, "ASSETS", "r2"),
    ]);
    expect(names.size).toBe(3);
  });

  test("never exceeds the 63-char cap and stays a valid name — long slug", () => {
    const identity = { project: "acme", issue: "1", slug: "a".repeat(80) };
    for (const kind of KINDS) {
      const name = featureResourceName(identity, "DB", kind);
      expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
      expect(name).toMatch(VALID);
    }
    // Deterministic + distinct for two different long slugs that share a head.
    const a = featureResourceName({ project: "acme", issue: "1", slug: `${"x".repeat(60)}-one` }, "DB", "d1");
    const b = featureResourceName({ project: "acme", issue: "1", slug: `${"x".repeat(60)}-two` }, "DB", "d1");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
  });

  test("never exceeds the cap even with a long binding name", () => {
    // A realistically long binding (kebab > the old fixed 24-char reserve) must not overrun.
    const name = featureResourceName(base, "USER_NOTIFICATION_PREFERENCES_STORE", "kv");
    expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
    expect(name).toMatch(VALID);
  });

  test("never exceeds the cap even when slug and binding are both long", () => {
    const identity = { project: "acme", issue: "123", slug: "z".repeat(50) };
    const name = featureResourceName(identity, "SOME_VERY_LONG_BINDING_NAME_INDEED", "r2");
    expect(name.length).toBeLessThanOrEqual(MAX_RESOURCE_NAME);
    expect(name).toMatch(VALID);
    expect(name.startsWith("acme-f123-")).toBe(true);
  });
});
