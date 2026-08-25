// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import type { BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type AuthCapability, type AuthConfigInput, auth, isAuthCapability } from "./capability";
import {
  AUTH_APPLE_CREDENTIALS,
  AUTH_FACEBOOK_CREDENTIALS,
  AUTH_GITHUB_CREDENTIALS,
  AUTH_GOOGLE_CREDENTIALS,
  AUTH_SESSION_SECRET,
  authSecretsRegistry,
} from "./instance/secrets";
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

// What an adopter can add, what they cannot displace, and what happens to the tables either way.
describe("additional Better Auth plugins", () => {
  test("a project that adds none is byte-identical to before — one migration, no extensions", () => {
    const cap = build();
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual(["0001_init"]);
    expect(cap.extensions).toEqual([]);
  });

  test("a composed plugin contributes its migration, keyed by its id", () => {
    const cap = build({ plugins: [organization()] });
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual(["0001_init", "0002_plugin_organization"]);
  });

  test("a composed plugin is declared as an extension, with the tables it brought", () => {
    // The one place a plugin is visible to anything outside `pithy.config.ts`: it has no package.json
    // for `pithy doctor` to read a name off, and it adds both routes and tables.
    expect(build({ plugins: [organization()] }).extensions).toEqual([
      { kind: "better-auth-plugin", id: "organization", tables: ["organization", "member", "invitation"] },
    ]);
  });

  test("a plugin that brings no tables is still declared — routes are not nothing", () => {
    expect(build({ plugins: [admin()] }).extensions).toEqual([{ kind: "better-auth-plugin", id: "admin", tables: [] }]);
  });

  test("a config naming one of the kit's own is refused, naming it", () => {
    expect(() => build({ plugins: [magicLink({ sendMagicLink: async () => {} })] })).toThrow(ValidationError);
    expect(() => build({ plugins: [magicLink({ sendMagicLink: async () => {} })] })).toThrow(/magic-link/);
  });

  test("a value that is not a plugin is refused at the config boundary", () => {
    expect(() => build({ plugins: ["organization" as unknown as BetterAuthPlugin] })).toThrow();
  });

  // A plugin's tables carry the plugin's own names, with no `pithy_auth_` prefix keeping them out of an
  // adopter's way. `auth()` sees only itself, so the collision is asked about at composition.
  describe("a plugin's table against the rest of the composition", () => {
    const cap = build({ plugins: [organization()] });
    const email = {
      name: "email",
      requiredBindings: [],
      emailConfig: {},
      enqueue: async () => {},
    } as unknown as Capability;

    function composeWith(...others: Capability[]): void {
      cap.compose?.({ capabilities: [email, cap, ...others] });
    }

    test("passes when nothing else claims one", () => {
      expect(() => composeWith()).not.toThrow();
    });

    test("is refused at boot when another capability declares the same table, naming both", () => {
      const rival = {
        name: "crm",
        requiredBindings: [],
        databases: { app: { binding: "DB", tables: { member: z.object({}) } } },
      } as unknown as Capability;

      expect(() => composeWith(rival)).toThrow(ValidationError);
      expect(() => composeWith(rival)).toThrow(/member/);
      expect(() => composeWith(rival)).toThrow(/crm/);
    });

    test("a same-named table in a different D1 binding is not a collision", () => {
      const elsewhere = {
        name: "crm",
        requiredBindings: [],
        databases: { analytics: { binding: "ANALYTICS", tables: { member: z.object({}) } } },
      } as unknown as Capability;

      expect(() => composeWith(elsewhere)).not.toThrow();
    });
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

  test("its devSecrets are exactly the registry entries that declare a devValue — nothing else checks", () => {
    // `pithy add` reads the manifest without executing this package, so the manifest carries the
    // projection. Both directions: a registry entry marked generatable and left out of the manifest is
    // never minted, and a manifest name the registry does not mark is a value written for nothing.
    const entries: [string, SecretRegistryEntry][] = Object.entries(authSecretsRegistry);
    const declared = entries
      .filter(([, entry]) => entry.devValue)
      .map(([name, entry]) => ({ name, devValue: entry.devValue }));
    expect(manifest.devSecrets).toEqual(declared);
  });

  test("every registry entry is in the manifest, and says where it comes from and how it is replaced", () => {
    // Stated as the invariant, not as a filtered comparison. The filtered version — build `declared`
    // from the entries that declare both axes, compare — could not fail for the one case it existed to
    // catch: an entry declaring neither axis is dropped from `declared` and is absent from the manifest,
    // so it vanishes from both sides and the comparison passes. Silent drift is the drift #322 ends.
    const entries: [string, SecretRegistryEntry][] = Object.entries(authSecretsRegistry);
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(entries.map(([name]) => name));
    for (const [name, entry] of entries) {
      expect(entry.origin, `${name} declares no origin`).toBeDefined();
      expect(entry.rotation, `${name} declares no rotation`).toBeDefined();
      expect(manifest.secrets.find((secret) => secret.name === name)).toEqual({
        name,
        origin: entry.origin,
        rotation: entry.rotation,
      });
    }
  });

  test("says where a human gets each OAuth pair, and where the same human rotates it", () => {
    // The honest floor. Nothing will ever mint a Google client secret, so the whole of what the kit can
    // do is name the page — and a client reading this renders a link instead of a bare "not set".
    const obtained = manifest.secrets.filter((secret) => secret.origin.kind === "obtained");
    expect(obtained.map((secret) => secret.name)).toEqual([
      AUTH_GOOGLE_CREDENTIALS,
      AUTH_APPLE_CREDENTIALS,
      AUTH_FACEBOOK_CREDENTIALS,
      AUTH_GITHUB_CREDENTIALS,
    ]);
    for (const secret of obtained) {
      expect(secret.rotation.kind).toBe("manual");
      expect(secret.origin.kind === "obtained" && secret.origin.documentation).toMatch(/^https:\/\//);
    }
  });

  test("mints only the session secret — the four OAuth pairs are registered with a provider", () => {
    // A generated Google client secret authenticates against nothing. It would replace a loud gap
    // with a quiet one.
    expect(manifest.devSecrets).toEqual([{ name: AUTH_SESSION_SECRET, devValue: "random" }]);
  });
});
