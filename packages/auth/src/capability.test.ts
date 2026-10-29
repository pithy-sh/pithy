// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { effectiveRetention, subjectClasses } from "@pithy-sh/core/src/retention/composed";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { turnstile } from "@pithy-sh/turnstile/src/capability";
import type { BetterAuthPlugin } from "better-auth";
// The barrel, for this one only: `better-auth` publishes no `./plugins/oauth-popup` export entry.
import { oauthPopup } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AuthAuditActions } from "./audit/actions";
import {
  type AuthCapability,
  AuthConfig,
  type AuthConfigInput,
  auth,
  isAuthCapability,
  turnstileLoginGate,
} from "./capability";
import {
  AUTH_APPLE_CREDENTIALS,
  AUTH_FACEBOOK_CREDENTIALS,
  AUTH_GITHUB_CREDENTIALS,
  AUTH_GOOGLE_CREDENTIALS,
  AUTH_MICROSOFT_CREDENTIALS,
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
    expect(tables.length).toBe(10);
    for (const name of tables) expect(name.startsWith("pithyAuth")).toBe(true);
  });

  test("ships every migration in one namespace, at the one declared order", () => {
    const db = build().databases?.app;
    expect(Object.keys(db?.migrations ?? {})).toEqual([
      "0001_init",
      "0002_session_authenticated_at",
      "0003_account_issuer_nullable",
      "0004_user_lifecycle",
      "0005_purge_once",
      "0006_verification_outcomes",
      "0007_erasure_record",
      "0008_last_active",
    ]);
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
    expect(cap.authConfig.microsoft.enabled).toBe(false);
  });

  test("microsoft is a toggle like the other four: off, may sign up, and described", () => {
    const cap = build();
    expect(cap.authConfig.microsoft).toEqual({ enabled: false, allowSignUp: true });
    expect(AuthConfig.shape.microsoft.description).toMatch(/auth-microsoft-credentials/);
    expect(AuthConfig.shape.microsoft.description).toMatch(/docs\/microsoft-oauth\.md/);
    expect(build({ microsoft: { enabled: true } }).authConfig.microsoft.enabled).toBe(true);
  });

  test("a provider may create accounts by default, and each toggle says so independently", () => {
    // `allowSignUp` defaults true so nothing about google/apple/facebook changes. It is the GitHub case
    // that needed saying: the dashboard wants *email* sign-up and *no* GitHub sign-up, which was
    // unexpressible — and that is exactly how an orphan user appeared (pithy-sh/pithy#554).
    const cap = build();
    expect(cap.authConfig.github.allowSignUp).toBe(true);
    expect(cap.authConfig.google.allowSignUp).toBe(true);
  });

  test("a provider's sign-up policy is separate from the global one", () => {
    // Two different questions. `disableSignUp` governs magic link and OTP; this governs one provider.
    const cap = build({ disableSignUp: false, github: { enabled: true, allowSignUp: false } });
    expect(cap.authConfig.disableSignUp).toBe(false);
    expect(cap.authConfig.github.allowSignUp).toBe(false);
    expect(cap.authConfig.google.allowSignUp).toBe(true);
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
  test("a project that adds none is byte-identical to before — the kit's own chain, no extensions", () => {
    const cap = build();
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual([
      "0001_init",
      "0002_session_authenticated_at",
      "0003_account_issuer_nullable",
      "0004_user_lifecycle",
      "0005_purge_once",
      "0006_verification_outcomes",
      "0007_erasure_record",
      "0008_last_active",
    ]);
    expect(cap.extensions).toEqual([]);
  });

  test("a composed plugin contributes its migration, keyed by its id", () => {
    const cap = build({ plugins: [organization()] });
    expect(Object.keys(cap.databases?.app?.migrations ?? {})).toEqual([
      "0001_init",
      "0002_session_authenticated_at",
      "0003_account_issuer_nullable",
      "0004_user_lifecycle",
      "0005_purge_once",
      "0006_verification_outcomes",
      "0007_erasure_record",
      "0008_last_active",
      "0002_plugin_organization",
    ]);
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

  test("a plugin whose refusals the capability cannot collapse is refused by `auth()` itself (#625)", () => {
    // The unit case lives in `instance/plugins.test.ts`. This one is about the *wiring*: the gate is worth
    // nothing if `auth()` does not run it, and `oauthPopup()` composed here would restore the
    // account-enumeration oracle on the social callback with no malformed input anywhere.
    expect(() => build({ plugins: [oauthPopup()] })).toThrow(ValidationError);
    expect(() => build({ plugins: [oauthPopup()] })).toThrow(/oauth-popup/);
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
describe("the turnstile login gate", () => {
  const sitekeys = { dev: "d", staging: "s", prod: "p" };

  test("carries the token source turnstile's config names, the one its client projection hands a screen", () => {
    const cap = turnstile({ widgets: { visible: { sitekeys } }, token: { header: "x-turnstile-token" } });
    expect(turnstileLoginGate(cap)).toEqual({
      mode: "visible",
      token: { field: "cf-turnstile-response", header: "x-turnstile-token" },
    });
  });

  test("is absent when turnstile is not composed, or does not protect sign-in", () => {
    expect(turnstileLoginGate(undefined)).toBeUndefined();
    const unprotected = turnstile({ widgets: { visible: { sitekeys } }, protect: {} });
    expect(turnstileLoginGate(unprotected)).toBeUndefined();
  });
});

describe("auth client projection", () => {
  const context = { environment: "production" };

  test("projects exactly the six keys a sign-in screen needs", () => {
    const projection = resolveClientProjection(build(), context);
    expect(Object.keys(projection).sort()).toEqual([
      "basePath",
      "enabled",
      "otpLength",
      "providerSignUp",
      "providers",
      "signUpEnabled",
    ]);
    expect(projection).toEqual({
      enabled: true,
      basePath: "/auth",
      providers: { google: false, apple: false, facebook: false, github: false, microsoft: false },
      // Per provider, beside the global one: a project may let email create accounts while a provider
      // may not, and a screen with only `signUpEnabled` promises what that provider refuses (#559).
      providerSignUp: { google: true, apple: true, facebook: true, github: true, microsoft: true },
      otpLength: 6,
      signUpEnabled: true,
    });
  });

  test("a provider's sign-up policy reaches the browser, so the promise can be scoped", () => {
    const projection = resolveClientProjection(build({ github: { enabled: true, allowSignUp: false } }), context);
    expect(projection.providerSignUp).toEqual({
      google: true,
      apple: true,
      facebook: true,
      github: false,
      microsoft: true,
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
    expect(on).toEqual({
      ...off,
      providers: { google: true, apple: false, facebook: false, github: false, microsoft: false },
    });
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
      AUTH_MICROSOFT_CREDENTIALS,
    ]);
    for (const secret of obtained) {
      expect(secret.rotation.kind).toBe("manual");
      expect(secret.origin.kind === "obtained" && secret.origin.documentation).toMatch(/^https:\/\//);
    }
  });

  test("mints only the session secret — the five OAuth credentials are registered with a provider", () => {
    // A generated Google client secret authenticates against nothing. It would replace a loud gap
    // with a quiet one.
    expect(manifest.devSecrets).toEqual([{ name: AUTH_SESSION_SECRET, devValue: "random" }]);
  });
});

describe("the account lifecycle config (#620)", () => {
  test("retention defaults to a 30-day purge window when nothing says otherwise", () => {
    expect(build().authConfig.retention).toEqual({ purgeAfterDays: 30 });
    expect(AuthConfig.parse({ baseURL: "https://api.example.com" }).retention.purgeAfterDays).toBe(30);
  });

  test("retention.purgeAfterDays takes a positive integer", () => {
    expect(build({ retention: { purgeAfterDays: 7 } }).authConfig.retention.purgeAfterDays).toBe(7);
    for (const purgeAfterDays of [0, -1, 1.5]) {
      expect(() => build({ retention: { purgeAfterDays } }), String(purgeAfterDays)).toThrow();
    }
  });

  test("all four lifecycle emails send by default, and each can be switched off on its own", () => {
    expect(build().authConfig.lifecycleEmails).toEqual({
      accountSuspended: true,
      accountReinstated: true,
      deletionScheduled: true,
      deletionComplete: true,
    });
    expect(build({ lifecycleEmails: { accountSuspended: false } }).authConfig.lifecycleEmails).toEqual({
      accountSuspended: false,
      accountReinstated: true,
      deletionScheduled: true,
      deletionComplete: true,
    });
  });

  test("both keys describe themselves, like every other config key", () => {
    expect(AuthConfig.shape.retention.description).toBeTruthy();
    expect(AuthConfig.shape.lifecycleEmails.description).toBeTruthy();
  });

  test("the four hooks are behavior, not config: kept off the parse and handed to the wiring", () => {
    const calls: string[] = [];
    const cap = auth({
      baseURL: "https://api.example.com",
      onUserSuspended: () => {
        calls.push("suspended");
      },
      onUserReinstated: () => {
        calls.push("reinstated");
      },
      onUserDeleted: () => {
        calls.push("deleted");
      },
      onUserPurged: () => {
        calls.push("purged");
      },
    });
    expect(Object.keys(cap.authConfig)).not.toContain("onUserSuspended");
    expect(Object.keys(cap.lifecycleHooks).sort()).toEqual([
      "onUserDeleted",
      "onUserPurged",
      "onUserReinstated",
      "onUserSuspended",
    ]);
  });
});

describe("the erasure record (#823)", () => {
  test("declares the user subject, its resource type, and every action its deletion and purge record", () => {
    // The control plane finds this among the composed capabilities: drop it, or name a wrong action, and every
    // user attestation is a 404, cites no deletion, or names no failure, with nothing else failing. Each of the
    // three deletions is cited: an operator's soft and hard, and a person's own.
    const records = build().erasureRecords;
    expect(records).toMatchObject({
      subject: "user",
      resourceType: "user",
      auditActions: {
        deleted: [
          AuthAuditActions.adminUserSoftDeleted,
          AuthAuditActions.adminUserHardDeleted,
          AuthAuditActions.userSelfDeleted,
        ],
        step: AuthAuditActions.adminUserPurgeStep,
        failed: AuthAuditActions.adminUserPurgeFailed,
        purged: AuthAuditActions.adminUserPurged,
      },
    });
    expect(records?.auditActions).toEqual({
      deleted: ["auth/admin_user_soft_deleted", "auth/admin_user_hard_deleted", "auth/user_self_deleted"],
      step: "auth/admin_user_purge_step",
      failed: "auth/admin_user_purge_failed",
      purged: "auth/admin_user_purged",
    });
    expect(typeof records?.read).toBe("function");
  });

  test("reading it without the configured DB binding is an internal error, never a silent empty record", () => {
    expect(() => build().erasureRecords?.read({})).toThrow(InternalError);
    expect(() => build().erasureRecords?.read({ DB: null })).toThrow(/auth database binding is missing/);
    // It reads the binding auth was configured with, not DB.
    expect(() => build({ database: "ANALYTICS" }).erasureRecords?.read({ DB: {} })).toThrow(InternalError);
  });
});

describe("the deletion lifecycle on the capability (#622)", () => {
  test("restoreUrl is optional, takes an http(s) page, and refuses anything else", () => {
    expect(build().authConfig.retention.restoreUrl).toBeUndefined();
    expect(
      build({ retention: { restoreUrl: "https://app.example.com/restore" } }).authConfig.retention.restoreUrl,
    ).toBe("https://app.example.com/restore");
    // The mail's button is a tracked click when click tracking is on, and a tracked click redirects only to a web
    // address — so a mailto: would be a button that answers `email/invalid_token`.
    for (const restoreUrl of ["mailto:help@example.com", "the support page", "javascript:alert(1)"]) {
      expect(() => build({ retention: { restoreUrl } }), restoreUrl).toThrow();
    }
  });

  test("declares its own purge contribution for a user, and the two Workflows the adopter hosts", () => {
    const cap = build();
    expect(cap.purge?.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(Object.keys(cap.workflows ?? {}).sort()).toEqual(["purge", "purge-due"]);
    // No class, because the class is the adopter's; optional, so a Worker boots before they bind it.
    for (const spec of Object.values(cap.workflows ?? {})) {
      expect(spec.className).toBeUndefined();
      expect(spec.optional).toBe(true);
    }
  });

  test("compose fills the purge steps from every composed capability, auth's own among them", () => {
    const cap = build();
    expect(cap.purgeSteps).toEqual([]);
    const media: Capability = {
      name: "media",
      requiredBindings: [],
      purge: [{ subject: "user", summary: "Deletes uploads.", erase: async () => {} }],
    };
    const email = {
      name: "email",
      requiredBindings: [],
      enqueue: async () => ({}),
      emailConfig: {},
    } as unknown as Capability;
    cap.compose?.({ capabilities: [email, cap, media] });
    expect(cap.purgeSteps.map((step) => step.step)).toEqual(["auth", "media"]);
  });
});

describe("the classes a user's rows hold", () => {
  test("auth's own tables mark the account's name and email pii, so a pii class age reaches every account", () => {
    expect(subjectClasses([auth({ baseURL: "https://api.example.com" })], "user")).toContain("pii");
  });
});

describe("the retention floor over auth's lifecycle", () => {
  test("refuses a short window on suspensions, reinstatements and restores, not only on the erasure", () => {
    const caps = [auth({ baseURL: "https://api.example.com" })];
    expect(() => effectiveRetention({ audit: { prefixes: { "auth/admin_user_re": "30d" } } }, caps)).toThrow(
      /floor of 365/,
    );
    const floored = effectiveRetention({ audit: { default: "30d" } }, caps).audit.floored;
    expect(floored).toEqual(
      expect.arrayContaining([
        AuthAuditActions.adminUserSuspended,
        AuthAuditActions.adminUserReinstated,
        AuthAuditActions.adminUserRestored,
      ]),
    );
  });
});
