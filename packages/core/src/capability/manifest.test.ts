import { describe, expect, test } from "vitest";
import { CapabilityManifest } from "./manifest";

describe("CapabilityManifest", () => {
  test("parses a full auth manifest", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [
        { type: "d1", name: "DB" },
        { type: "kv", name: "SESSIONS" },
      ],
      peerCapabilities: ["email"],
      optionalCapabilities: ["turnstile"],
      migrationNamespace: "auth",
      scaffold: ["register auth() in pithy.config.ts"],
      whenToEnable: "Enable when your app needs user accounts.",
    });
    expect(parsed.name).toBe("auth");
    expect(parsed.package).toBe("@pithy-sh/auth");
    expect(parsed.peerCapabilities).toEqual(["email"]);
    expect(parsed.optionalCapabilities).toEqual(["turnstile"]);
    expect(parsed.migrationNamespace).toBe("auth");
    expect(parsed.scaffold).toEqual(["register auth() in pithy.config.ts"]);
    expect(parsed.whenToEnable).toBe("Enable when your app needs user accounts.");
  });

  test("normalizes requiredBindings through BindingSpec (optional defaults to false)", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [{ type: "d1", name: "DB" }],
    });
    expect(parsed.requiredBindings).toEqual([{ type: "d1", name: "DB", optional: false }]);
  });

  test("applies empty-array defaults for the optional lists", () => {
    const parsed = CapabilityManifest.parse({
      name: "turnstile",
      package: "@pithy-sh/turnstile",
      requiredBindings: [{ type: "secret", name: "TURNSTILE_SECRET" }],
    });
    expect(parsed.peerCapabilities).toEqual([]);
    expect(parsed.optionalCapabilities).toEqual([]);
    expect(parsed.scaffold).toEqual([]);
  });

  test("leaves migrationNamespace and whenToEnable undefined when omitted", () => {
    const parsed = CapabilityManifest.parse({
      name: "turnstile",
      package: "@pithy-sh/turnstile",
      requiredBindings: [],
    });
    expect(parsed.migrationNamespace).toBeUndefined();
    expect(parsed.whenToEnable).toBeUndefined();
  });

  test("rejects a manifest with no package", () => {
    expect(() => CapabilityManifest.parse({ name: "x", requiredBindings: [] })).toThrow();
  });

  test("rejects an empty name", () => {
    expect(() => CapabilityManifest.parse({ name: "", package: "@pithy-sh/x", requiredBindings: [] })).toThrow();
  });

  test("rejects an empty package", () => {
    expect(() => CapabilityManifest.parse({ name: "x", package: "", requiredBindings: [] })).toThrow();
  });

  test("accepts a registry-valid migrationNamespace", () => {
    const parsed = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      migrationNamespace: "auth",
    });
    expect(parsed.migrationNamespace).toBe("auth");
  });

  test("rejects a migrationNamespace the migration registry would reject", () => {
    for (const ns of ["Auth", "auth_core", "1auth", "auth-core", ""]) {
      expect(() =>
        CapabilityManifest.parse({
          name: "x",
          package: "@pithy-sh/x",
          requiredBindings: [],
          migrationNamespace: ns,
        }),
      ).toThrow();
    }
  });

  test("rejects an invalid binding in requiredBindings", () => {
    expect(() =>
      CapabilityManifest.parse({
        name: "x",
        package: "@pithy-sh/x",
        requiredBindings: [{ type: "banana", name: "Q" }],
      }),
    ).toThrow();
  });
});
