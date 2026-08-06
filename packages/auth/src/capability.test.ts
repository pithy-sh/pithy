// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
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

  test("ships both migrations in one namespace, at the one declared order", () => {
    const db = build().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual(["0001_init"]);
    // A second migration never gets a second order. Renumbering would rename `0300_auth_0001_init`, and
    // Kysely would then read every applied auth migration as unapplied and run it again.
    expect(db?.migrationOrder).toBe(AUTH_MIGRATION_ORDER);
  });

  test("advertises its control-plane admin surface, built from the resolved basePath", () => {
    const cap = build();
    expect(cap.adminRoutes ?? []).not.toHaveLength(0);
    for (const route of cap.adminRoutes ?? []) {
      expect(route.path.startsWith("/auth/admin/"), route.path).toBe(true);
      // Every admin route names a scope. An unscoped one would be an admin route anybody verified could
      // call, which on an identity surface is the whole user table.
      expect(route.scope, route.path).toBeTruthy();
    }
    const moved = auth({ baseURL: "https://api.example.com", basePath: "/identity" });
    for (const route of moved.adminRoutes ?? []) {
      expect(route.path.startsWith("/identity/admin/"), route.path).toBe(true);
    }
  });

  test("contributes the same-origin, rate-limit and session middleware, and routes", () => {
    const cap = build();
    // Three middleware, in this order: the same-origin policy is published first so every route —
    // auth's and the adopter's — can gate on it; then the tier-1 edge rate limiter; then session
    // resolution.
    expect(cap.middleware?.length).toBe(3);
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

// The client projection is a security boundary: it is the only auth config a browser bundle sees.
describe("auth client projection", () => {
  const context = { environment: "production" };

  test("projects exactly the five keys a sign-in screen needs", () => {
    const projection = resolveClientProjection(build(), context);
    expect(Object.keys(projection).sort()).toEqual(["basePath", "enabled", "otpLength", "providers", "signUpEnabled"]);
    expect(projection).toEqual({
      enabled: true,
      basePath: "/auth",
      providers: { google: false, apple: false, facebook: false, github: false },
      otpLength: 6,
      signUpEnabled: true,
    });
  });

  test("no deployment or sensitive config value reaches the bundle", () => {
    // A sensitive-looking extra field, as an adopter (or a future schema edit) might introduce it.
    const extra = { oauthClientSecret: "sk_live_never_ship_me" } as unknown as Partial<AuthConfigInput>;
    const cap = auth({
      baseURL: "https://internal-api.example.com",
      trustedOrigins: ["https://console.example.com"],
      database: "PRIVATE_DB",
      rateLimiterBinding: "PRIVATE_LIMITER",
      sessionExpiresIn: 111111,
      sessionUpdateAge: 222222,
      verificationExpiresIn: 333333,
      ...extra,
    });
    const serialized = JSON.stringify(resolveClientProjection(cap, context));
    for (const secret of [
      "sk_live_never_ship_me",
      "internal-api.example.com",
      "console.example.com",
      "PRIVATE_DB",
      "PRIVATE_LIMITER",
      "111111",
      "222222",
      "333333",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("a provider toggle flips exactly one boolean", () => {
    const off = resolveClientProjection(build(), context);
    const on = resolveClientProjection(build({ google: { enabled: true } }), context);
    expect(on).toEqual({ ...off, providers: { google: true, apple: false, facebook: false, github: false } });
  });

  test("disableSignUp projects as signUpEnabled: false", () => {
    expect(resolveClientProjection(build({ disableSignUp: true }), context).signUpEnabled).toBe(false);
  });

  test("otpLength and basePath follow config", () => {
    const projection = resolveClientProjection(build({ otpLength: 8, basePath: "/identity" }), context);
    expect(projection.otpLength).toBe(8);
    expect(projection.basePath).toBe("/identity");
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
