// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import { isEmailCapability } from "@pithy-sh/email/src/capability";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import { TURNSTILE_LOGIN_ACTION, type TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import { z } from "zod";
import type { AuthClientProjection } from "./client/projection";
import { authTables } from "./data/tables";
import { publishSameOrigin } from "./http/csrf";
import { registerDevLoginRoute } from "./http/devLoginRoute";
import { authAdminRoutes } from "./http/guards";
import { createSessionMiddleware } from "./http/middleware";
import { createRateLimitMiddleware } from "./http/rateLimit";
import { createAuthRoutes } from "./http/routes";
import { AuthPlugin, assertAdditivePlugins } from "./instance/plugins";
import { authSecretsRegistry } from "./instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./migrations/0001_init";
import { authPluginPlan } from "./migrations/pluginTables";
import { authDevSessionSeed } from "./seeds/devSession";
import { authExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";

/** A social provider toggle. Credentials live in the secrets store, never config. */
const ProviderToggle = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe("Whether this social provider is enabled. Credentials are read from the secrets store, never config."),
  })
  .describe("A social provider's on/off toggle.");

/** The auth capability's configuration — the thin surface an adopter owns in `pithy.config.ts`. */
export const AuthConfig = z
  .object({
    basePath: z
      .string()
      .default("/auth")
      .describe(
        "The path the auth handler mounts under. Must match the OAuth redirect URIs you register. Defaults to `/auth`.",
      ),
    baseURL: z
      .string()
      .describe(
        "The public origin of this worker where it is deployed (no trailing slash). OAuth callbacks, JWKS and magic-link URLs are built from it. A `dev` composition ignores it and serves on `http://<the host the request arrived at>` instead — local dev has no TLS and its port is assigned per run, so it is the one address nobody can write down.",
      ),
    trustedOrigins: z
      .array(z.string())
      .default([])
      .describe(
        "Web origins and mobile deep-link schemes allowed as redirect targets and for cookie CSRF origin checks (e.g. `https://app.example.com`, `myapp://`).",
      ),
    database: z
      .string()
      .default("DB")
      .describe("The D1 binding the auth tables and migrations target. Defaults to `DB`, the shared app database."),
    rateLimiterBinding: z
      .string()
      .default("AUTH_RATE_LIMITER")
      .describe(
        "The Workers Rate Limiting binding for the coarse per-IP edge guard on the auth routes (tier 1). Its limit and window are set on the binding in wrangler.jsonc. Complements Better Auth's per-action limiter (tier 2).",
      ),
    google: ProviderToggle.default({ enabled: false }).describe(
      "Google OAuth. Enable it, then store credentials as the `auth-google-credentials` secret. See docs/google-oauth.md.",
    ),
    apple: ProviderToggle.default({ enabled: false }).describe(
      "Apple Sign-In. Enable it, then store credentials as the `auth-apple-credentials` secret. See docs/apple-signin.md.",
    ),
    facebook: ProviderToggle.default({ enabled: false }).describe(
      "Facebook Login. Enable it, then store credentials as the `auth-facebook-credentials` secret. See docs/facebook-oauth.md.",
    ),
    github: ProviderToggle.default({ enabled: false }).describe(
      "GitHub OAuth. Enable it, then store credentials as the `auth-github-credentials` secret. See docs/github-oauth.md.",
    ),
    sessionExpiresIn: z
      .number()
      .int()
      .default(60 * 60 * 24 * 7)
      .describe("Session (refresh credential) lifetime in seconds. Defaults to 7 days. Expiry slides forward on use."),
    sessionUpdateAge: z
      .number()
      .int()
      .default(60 * 60 * 24)
      .describe("How often (seconds) an active session's expiry slides forward. Defaults to 1 day."),
    verificationExpiresIn: z
      .number()
      .int()
      .default(300)
      .describe("Magic-link and OTP lifetime in seconds. Defaults to 5 minutes. Single-use regardless."),
    otpLength: z.number().int().default(6).describe("The number of digits in an email OTP. Defaults to 6."),
    disableSignUp: z
      .boolean()
      .default(false)
      .describe(
        "When true, sign-in never provisions a new user — existing accounts only. Unknown emails get no email (anti-enumeration).",
      ),
    plugins: z
      .array(AuthPlugin)
      .default([])
      .describe(
        "Additional Better Auth plugins to compose — `organization()`, `passkey()`, `twoFactor()`, `apiKey()`, a generic OAuth provider. Additive: they join the set the kit composes (i18n, bearer, jwt, magic-link, email-otp) and cannot replace one. Tables a plugin declares are created by `pithy migrate`; add the matching client plugin to `createAuthClient` for its typed client surface.",
      ),
  })
  .describe("Configuration for the auth capability.");
export type AuthConfig = z.output<typeof AuthConfig>;
export type AuthConfigInput = z.input<typeof AuthConfig>;

/**
 * The runtime wiring the middleware and routes close over. `config` is known at `auth()` call time;
 * `emailConfig` and `turnstile` are filled by `compose` from the composed peer capabilities, before
 * any request runs.
 */
export interface AuthWiring {
  config: AuthConfig;
  /** The email capability's bound enqueue seam — how magic-link/OTP are delivered. Set by `compose`. */
  enqueueEmail: EmailCapability["enqueue"] | undefined;
  /** The turnstile login gate, when the turnstile capability is composed. Set by `compose`. */
  turnstile: { mode: TurnstileMode } | undefined;
}

/** The auth capability, with its resolved config attached for inspection. */
export interface AuthCapability extends Capability {
  authConfig: AuthConfig;
}

/**
 * Refuse a composition where a Better Auth plugin's table is one another capability already declares in
 * the same database. `capabilities` is every capability composed into this backend, so this is the first
 * moment the question can be asked at all — `auth()` sees only itself.
 */
function assertPluginTablesUnclaimed(
  capabilities: readonly Capability[],
  binding: string,
  extensions: readonly { id: string; tables: string[] }[],
): void {
  const claimed = new Map<string, string>();
  for (const capability of capabilities) {
    if (capability.name === "auth") continue;
    for (const spec of Object.values(capability.databases ?? {})) {
      if (spec.binding !== binding) continue;
      for (const table of Object.keys(spec.tables)) claimed.set(table, capability.name);
    }
  }
  for (const extension of extensions) {
    for (const table of extension.tables) {
      const owner = claimed.get(table);
      if (!owner) continue;
      throw new ValidationError({
        message: `The Better Auth "${extension.id}" plugin and the ${owner} capability both use a ${table} table.`,
        action: `Rename the plugin's through its own \`schema: { ${table}: { modelName: "…" } }\` option, or point auth at another database.`,
        detail: `plugin "${extension.id}" table "${table}" is already declared by capability "${owner}" on binding ${binding}`,
      });
    }
  }
}

/**
 * The auth capability. Passwordless sign-in (magic link, OTP, Google, Apple), the hybrid bearer +
 * cookie token model, the per-device session registry, and the `bearer`/`session` fills for core's
 * `AuthContext` seam. Depends on `secrets` and `email`; auto-gates its send routes with `turnstile`
 * and emits `auth/*` through `audit` when those are composed.
 */
export function auth(config: AuthConfigInput): AuthCapability {
  const resolved = AuthConfig.parse(config);
  // Additivity, before anything is built from the list. The four the kit composes are the sign-in this
  // product promises and what the control-plane seam verifies against, so a list naming one of them is
  // refused here by name rather than silently redefining a route at request time.
  assertAdditivePlugins(resolved.plugins);
  // And the tables those plugins imply, derived now so a collision is a config error at `auth()` rather
  // than a half-applied migration against a database with no transactional DDL.
  const pluginPlan = authPluginPlan(resolved.plugins);
  const wiring: AuthWiring = { config: resolved, enqueueEmail: undefined, turnstile: undefined };

  // Tier-1 edge rate limiter, contributed as middleware so it runs before session resolution.
  const rateLimitMiddleware: PithyMiddleware = (app) => {
    app.use(`${resolved.basePath}/*`, createRateLimitMiddleware(resolved.rateLimiterBinding));
  };

  const capability = defineCapability({
    name: "auth",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    config: AuthConfig,
    dependsOn: ["secrets", "email"],
    secretRegistry: authSecretsRegistry,
    requiredBindings: [
      { type: "d1", name: resolved.database },
      { type: "ratelimit", name: resolved.rateLimiterBinding },
    ],
    // What the adopter plugged in, and what it brought with it. A composed plugin adds routes to this
    // Worker and tables to this database while having no package.json for anything to read a name off,
    // so without this line the only place it appears is the source of `pithy.config.ts`.
    extensions: pluginPlan.extensions.map((extension) => ({
      kind: "better-auth-plugin",
      id: extension.id,
      tables: extension.tables,
    })),
    databases: {
      app: {
        binding: resolved.database,
        tables: authTables,
        migrationOrder: AUTH_MIGRATION_ORDER,
        // One namespace, one order. `AUTH_MIGRATION_ORDER` is stable forever — renumbering it would
        // rename `0300_auth_0001_init` and re-run every applied auth migration.
        //
        // Beside the kit's own set: one derived migration per adopter plugin that declares a schema
        // (`0002_plugin_<id>`). That is the whole answer to "a plugin brings tables" — the plugin list
        // is in `pithy.config.ts`, which is the file `pithy migrate` already imports to collect
        // capabilities, so the tables ride the migration model that exists rather than needing a new
        // one. A project that composes no plugins contributes exactly what it did before.
        migrations: { "0001_init": auth_0001_init, ...pluginPlan.migrations },
      },
    },
    compose: ({ capabilities }) => {
      const email = capabilities.find(isEmailCapability);
      if (!email) {
        throw new ValidationError({
          message: "The auth capability requires the email capability.",
          action: "Add `email(...)` to your capabilities — magic-link and OTP delivery enqueue email jobs.",
        });
      }
      wiring.enqueueEmail = email.enqueue;
      // Auto-wire turnstile onto the login routes when it is composed (Jim's requirement: zero config).
      const turnstileCap = capabilities.find(isTurnstileCapability);
      const loginMode = turnstileCap?.turnstileConfig.protect[TURNSTILE_LOGIN_ACTION];
      wiring.turnstile = loginMode ? { mode: loginMode } : undefined;
      // And the one collision `auth()` could not see. A plugin's tables carry the plugin's own names —
      // `organization`, `member`, `invitation` — with no `pithy_auth_` prefix to keep them out of an
      // adopter's way, because they are the adopter's tables now. `composeDatabases` catches two
      // capabilities claiming one table because both declared it; a plugin's tables are not in the
      // declared map (they have no Zod schema), so this asks the same question of the composed set.
      // Refused at boot, naming both sides: the alternative is a `create table` that fails halfway
      // through `pithy migrate`, or two capabilities quietly reading and writing one table.
      assertPluginTablesUnclaimed(capabilities, resolved.database, pluginPlan.extensions);
    },
    /**
     * The client-safe projection — what a sign-in screen needs and nothing more: where to call
     * (`basePath`), which buttons to render (the four provider toggles), how many OTP boxes to draw
     * (`otpLength`), and whether to offer sign-up (`signUpEnabled`).
     *
     * Deliberately absent: `baseURL`, `trustedOrigins`, `database`, `rateLimiterBinding`, and every
     * session/verification lifetime — a browser has no use for them and they describe the deployment.
     * OAuth credentials cannot leak here because they are not in this config at all: they live in the
     * secrets store (`authSecretsRegistry`), read only inside the Worker. That is what makes this
     * projection provably safe — the sensitive values are not in reach of the function.
     *
     * The return type is {@link AuthClientProjection} — **declared, not inferred**. `Capability.client`
     * types this as `{ enabled: boolean }` plus a JSON catchall, which accepts anything this literal
     * could say. The declared type is what makes a dropped field — and a grown one, `baseURL` projected
     * "just for a redirect" — a compile error here rather than a browser's problem.
     */
    client: (): AuthClientProjection => ({
      enabled: true,
      basePath: resolved.basePath,
      // Nested, so a screen can iterate the set rather than naming four booleans — and so adding a
      // fifth provider is one key here, not a new top-level name every screen has to learn.
      providers: {
        google: resolved.google.enabled,
        apple: resolved.apple.enabled,
        facebook: resolved.facebook.enabled,
        github: resolved.github.enabled,
      },
      otpLength: resolved.otpLength,
      signUpEnabled: !resolved.disableSignUp,
    }),
    // Order matters: the same-origin policy is published first, so it is on the request before any
    // route can gate on it; then the tier-1 edge rate limiter (before session resolution touches D1);
    // then the session-resolution middleware fills the AuthContext.
    middleware: [publishSameOrigin(wiring), rateLimitMiddleware, createSessionMiddleware(wiring)],
    // The dev-login redirect goes on **first**, and the reason is `basePath`: it defaults to `/auth`,
    // but an adopter may mount auth at the root, and Better Auth's catch-all (`${basePath}/*`) returns
    // a Response, which ends the chain. Registered after it, `/__pithy/dev-login` would be a route the
    // table shows and nothing ever reaches. It registers itself only in a `dev` composition that is not
    // CI — see `http/devLoginRoute.ts` for the two gates and why they are two.
    routes: (app) => {
      registerDevLoginRoute(wiring)(app);
      createAuthRoutes(wiring)(app);
    },
    // Built from the RESOLVED basePath, never the default: an adopter who mounts auth at `/identity`
    // must get a manifest naming `/identity/admin/users`, or a management client composing its calls
    // from the manifest 404s against exactly the adopters who customized anything.
    adminRoutes: authAdminRoutes(resolved.basePath),
    // Order matters here too: the dev-session set sorts last, after every set that could create the user
    // it signs in as — this one's example cast included, and the adopter's own.
    seeds: [authExampleSeed, authDevSessionSeed],
  });

  return Object.assign(capability, { authConfig: resolved });
}

/** Type guard: is this capability the auth capability? */
export function isAuthCapability(capability: Capability): capability is AuthCapability {
  return capability.name === "auth" && "authConfig" in capability;
}
