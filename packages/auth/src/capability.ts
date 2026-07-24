import type { Capability, PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { EmailCapability } from "@pithy-sh/email/src/capability";
import { isEmailCapability } from "@pithy-sh/email/src/capability";
import { isTurnstileCapability } from "@pithy-sh/turnstile/src/capability";
import type { TurnstileMode } from "@pithy-sh/turnstile/src/config/config";
import { z } from "zod";
import { authTables } from "./data/tables";
import { createSessionMiddleware } from "./http/middleware";
import { createRateLimitMiddleware } from "./http/rateLimit";
import { createAuthRoutes } from "./http/routes";
import { authSecretsRegistry } from "./instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "./migrations/0001_init";
import { authExampleSeed } from "./seeds/example";

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
        "The public origin of this environment's auth worker (no trailing slash). OAuth callbacks and JWKS URLs are built from it.",
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
 * The auth capability. Passwordless sign-in (magic link, OTP, Google, Apple), the hybrid bearer +
 * cookie token model, the per-device session registry, and the `bearer`/`session` fills for core's
 * `AuthContext` seam. Depends on `secrets` and `email`; auto-gates its send routes with `turnstile`
 * and emits `auth/*` through `audit` when those are composed.
 */
export function auth(config: AuthConfigInput): AuthCapability {
  const resolved = AuthConfig.parse(config);
  const wiring: AuthWiring = { config: resolved, enqueueEmail: undefined, turnstile: undefined };

  // Tier-1 edge rate limiter, contributed as middleware so it runs before session resolution.
  const rateLimitMiddleware: PithyMiddleware = (app) => {
    app.use(`${resolved.basePath}/*`, createRateLimitMiddleware(resolved.rateLimiterBinding));
  };

  const capability = defineCapability({
    name: "auth",
    config: AuthConfig,
    dependsOn: ["secrets", "email"],
    secretRegistry: authSecretsRegistry,
    requiredBindings: [
      { type: "d1", name: resolved.database },
      { type: "ratelimit", name: resolved.rateLimiterBinding },
    ],
    databases: {
      app: {
        binding: resolved.database,
        tables: authTables,
        migrationOrder: AUTH_MIGRATION_ORDER,
        migrations: { "0001_init": auth_0001_init },
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
      const loginMode = turnstileCap?.turnstileConfig.protect.login;
      wiring.turnstile = loginMode ? { mode: loginMode } : undefined;
    },
    // Order matters: the tier-1 edge rate limiter runs first (before session resolution touches D1),
    // then the session-resolution middleware fills the AuthContext.
    middleware: [rateLimitMiddleware, createSessionMiddleware(wiring)],
    routes: createAuthRoutes(wiring),
    seeds: [authExampleSeed],
  });

  return Object.assign(capability, { authConfig: resolved });
}

/** Type guard: is this capability the auth capability? */
export function isAuthCapability(capability: Capability): capability is AuthCapability {
  return capability.name === "auth" && "authConfig" in capability;
}
