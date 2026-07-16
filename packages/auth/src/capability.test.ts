import { readFileSync } from "node:fs";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, test } from "vitest";
import { type AuthCapability, type AuthConfigInput, auth, isAuthCapability } from "./capability";
import { AUTH_MIGRATION_ORDER } from "./migrations/0001_init";

function build(overrides: Partial<AuthConfigInput> = {}): AuthCapability {
  return auth({ baseURL: "https://api.example.com", ...overrides });
}

describe("auth capability", () => {
  test("declares its dependencies and the D1 binding", () => {
    const cap = build();
    expect(cap.dependsOn).toEqual(["secrets", "email"]);
    expect(cap.requiredBindings.map((b) => [b.type, b.name])).toEqual([
      ["d1", "DB"],
      ["ratelimit", "AUTH_RATE_LIMITER"],
    ]);
    expect(cap.secretRegistry).toBeDefined();
  });

  // Table keys are camelCase (CamelCasePlugin emits the snake_case `pithy_auth_` SQL); every provided
  // table must be namespaced under the capability so it can't clash with an adopter's.
  test("every provided table is namespaced under pithyAuth (the pithy_auth_ prefix)", () => {
    const tables = Object.keys(build().databases?.app?.tables ?? {});
    expect(tables.length).toBe(8);
    for (const name of tables) expect(name.startsWith("pithyAuth")).toBe(true);
  });

  test("ships the 0001_init migration at its declared order", () => {
    const db = build().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual(["0001_init"]);
    expect(db?.migrationOrder).toBe(AUTH_MIGRATION_ORDER);
  });

  test("contributes the rate-limit + session middleware and routes", () => {
    const cap = build();
    // Two middleware: the tier-1 edge rate limiter (runs first) then session resolution.
    expect(cap.middleware?.length).toBe(2);
    expect(typeof cap.routes).toBe("function");
  });

  test("honors a configured database binding", () => {
    const cap = auth({ baseURL: "https://x", database: "ANALYTICS" });
    expect(cap.databases?.app?.binding).toBe("ANALYTICS");
    expect(cap.requiredBindings.map((b) => b.name)).toEqual(["ANALYTICS", "AUTH_RATE_LIMITER"]);
  });

  test("isAuthCapability recognizes it and rejects others", () => {
    expect(isAuthCapability(build())).toBe(true);
    expect(isAuthCapability({ name: "email", requiredBindings: [] })).toBe(false);
  });

  test("defaults the providers off and the mount to /auth", () => {
    const cap = build();
    expect(cap.authConfig.basePath).toBe("/auth");
    expect(cap.authConfig.google.enabled).toBe(false);
    expect(cap.authConfig.apple.enabled).toBe(false);
    expect(cap.authConfig.facebook.enabled).toBe(false);
    expect(cap.authConfig.github.enabled).toBe(false);
  });

  test("each provider toggle flips to enabled when set", () => {
    const cap = build({ facebook: { enabled: true }, github: { enabled: true } });
    expect(cap.authConfig.facebook.enabled).toBe(true);
    expect(cap.authConfig.github.enabled).toBe(true);
    // The unset providers stay off — each toggle is independent.
    expect(cap.authConfig.google.enabled).toBe(false);
    expect(cap.authConfig.apple.enabled).toBe(false);
  });
});

describe("pithy.manifest.json", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  test("is valid and matches the capability's name, package, and namespace", () => {
    expect(manifest.name).toBe("auth");
    expect(manifest.package).toBe("@pithy-sh/auth");
    expect(manifest.migrationNamespace).toBe("auth");
  });

  test("mirrors the runtime dependsOn as peerCapabilities", () => {
    expect(manifest.peerCapabilities).toEqual(build().dependsOn);
  });

  test("lists turnstile and audit as optional", () => {
    expect(manifest.optionalCapabilities).toEqual(["turnstile", "audit"]);
  });
});
