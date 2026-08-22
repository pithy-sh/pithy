// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthConfig, type AuthConfigInput, type AuthWiring } from "../capability";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER, auth_0001_init } from "../migrations/0001_init";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { createRateLimitMiddleware } from "./rateLimit";
import { createAuthRoutes } from "./routes";

/**
 * The gate for #381, and it is deliberately built out of HTTP rather than out of the declaration the
 * providers are built from.
 *
 * Nothing here reads `ResolvedProviders`, `socialProviders()`, or an `instance.options`. Every
 * assertion is a status code and a body from a real request against a real D1 and a real encrypted
 * secrets store, because the claim being made is about **who can sign in**, and a check that asked the
 * resolution what it resolved would answer yes for any resolution — including the one this branch
 * replaced. The plant is the absence of one encrypted row, which is the adopter's actual failure.
 *
 * What this suite separates, over HTTP:
 *
 * | GitHub in config | `auth-github-credentials` | magic link | `sign-in/social` for github |
 * | ---              | ---                       | ---        | ---                         |
 * | enabled          | provisioned               | works      | redirects to GitHub         |
 * | enabled          | **missing**               | works      | **503 `auth/provider_unavailable`** |
 * | **not enabled**  | irrelevant                | works      | **404 `PROVIDER_NOT_FOUND`** |
 * | enabled          | missing, *and* no session secret | fails | fails                  |
 *
 * Row two is the fix. Row three is the distinction the fix exists to draw — a fault and a choice are not
 * the same fact, and they answer differently. Row four is the precondition that keeps failing the whole
 * instance, which is the half of the issue that was already right and the half a change like this most
 * easily breaks.
 *
 * **Row three was once asserted without dispatching, and that hole is now closed (#385).** Under
 * workerd's pre-2026-03-03 behavior an `async` function that *returned* a rejected promise rather than
 * awaiting it fired `unhandledrejection` even where the caller awaited and caught it — Better Auth's
 * `runWithEndpointContext` is that shape, so asking for a provider the instance does not hold left two
 * phantom rejections behind and vitest counted them. The runtime fix is already shipped and default-on
 * from compatibility date 2026-03-03; `vitest.workers.config.ts` names the flag. So the disabled side is
 * a live request again, and the distinction is measured end to end rather than half proven by
 * construction.
 */

const SECRET = "test-secret-please-rotate-0000000000";
const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];

/** Everything provisioned — the healthy environment each case then subtracts from. */
const ALL_SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

/** The plant: GitHub's credential row is never written. Nothing else changes. */
const GITHUB_UNPROVISIONED: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": SECRET,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
};

/** The precondition's plant: the session secret is what an auth instance *is*, and it is missing. */
const NO_SESSION_SECRET: SecretFixture<typeof authSecretsRegistry> = {
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
};

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) } satisfies RateLimit,
  };
}

function wiring(config: Partial<AuthConfigInput> = {}): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      ...config,
    }),
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

/** The composed app, with a capturing audit seam so the operator's channel is observable. */
function buildApp(config: Partial<AuthConfigInput> = {}): { app: Hono<PithyHonoEnv>; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const emit: AuditEmit = async (event) => void events.push(event);
  const w = wiring(config);
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", emit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(w)(app);
  app.use(`${w.config.basePath}/*`, createRateLimitMiddleware(w.config.rateLimiterBinding));
  createSessionMiddleware(w)(app);
  createAuthRoutes(w)(app);
  return { app, events };
}

/** Ask for a magic link — the sign-in method that has nothing to do with any OAuth provider. */
async function magicLink(app: Hono<PithyHonoEnv>): Promise<Response> {
  return app.request(
    "/auth/sign-in/magic-link",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ email: "u@test.com", callbackURL: "http://localhost/" }),
    },
    appEnv(),
  );
}

/** Ask to sign in with a social provider. */
async function socialSignIn(app: Hono<PithyHonoEnv>, provider: string): Promise<Response> {
  return app.request(
    "/auth/sign-in/social",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ provider, callbackURL: "http://localhost/" }),
    },
    appEnv(),
  );
}

/** The `code` off a Pithy error envelope — every failure this kit renders itself. */
async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.json<{ error?: { code?: string } }>();
  return body.error?.code;
}

async function seed(fixture: SecretFixture<typeof authSecretsRegistry>): Promise<void> {
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, fixture);
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  // The store, not just its rows: a case seeds only the secrets it means to provision, so a row
  // surviving from the previous case would silently un-plant the next one.
  for (const table of ["pithy_secrets_system_secrets", "pithy_secrets_rotations"]) {
    await env.SECRETS.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: { "0001_init": auth_0001_init } },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("an enabled provider whose credential will not resolve", () => {
  const CONFIG = { github: { enabled: true }, google: { enabled: true } };

  test("magic link still signs people in — the blast radius is one provider, not the deployment", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app } = buildApp(CONFIG);
    const res = await magicLink(app);
    expect(res.status).toBe(200);
  });

  test("the healthy sibling provider still redirects to its issuer", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app } = buildApp(CONFIG);
    const res = await socialSignIn(app, "google");
    expect(res.status).toBe(200);
    const body = await res.json<{ url?: string; redirect?: boolean }>();
    expect(body.url).toContain("accounts.google.com");
  });

  test("the broken provider is refused with its own code, and 503 rather than 500", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app } = buildApp(CONFIG);
    const res = await socialSignIn(app, "github");
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("auth/provider_unavailable");
  });

  test("the caller is told what to do instead, and told nothing about the store", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app } = buildApp(CONFIG);
    const res = await socialSignIn(app, "github");
    const body = await res.json<{ error: { message: string; action?: string; detail?: string } }>();
    expect(body.error.message).toContain("github");
    expect(body.error.message).toContain("magic link");
    // The security boundary: `clientError` strips both, so the secret name in `action` and the
    // resolution context in `detail` reach the operator's channels and never the browser.
    expect(body.error.action).toBeUndefined();
    expect(body.error.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("auth-github-credentials");
  });

  test("the operator's channel names the provider — degrading, and saying so", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app, events } = buildApp(CONFIG);
    await socialSignIn(app, "github");
    const recorded = events.filter((event) => event.action === "auth/provider_unavailable");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("denied");
    expect(recorded[0]?.severity).toBe("warning");
    expect(recorded[0]?.metadata).toEqual({ provider: "github" });
  });

  test("no audit row names the secret — the trail is long-lived, and a store entry is a map", async () => {
    await seed(GITHUB_UNPROVISIONED);
    const { app, events } = buildApp(CONFIG);
    await socialSignIn(app, "github");
    expect(JSON.stringify(events)).not.toContain("auth-github-credentials");
  });
});

describe("a provider nobody enabled", () => {
  /**
   * The other side of the distinction, over HTTP, because that is where it is worth anything: an
   * operator reading a 503 `auth/provider_unavailable` learns something is broken, and a caller reading
   * Better Auth's 404 learns GitHub was never offered here. Same request, two different facts.
   *
   * Everything is provisioned, so nothing is unresolvable — the only thing missing is the enabling, and
   * the answer must come from Better Auth rather than from this kit's refusal.
   */
  test("answers Better Auth's own 404, not this kit's 503", async () => {
    await seed(ALL_SECRETS);
    const { app } = buildApp({ google: { enabled: true } });
    const res = await socialSignIn(app, "github");
    expect(res.status).toBe(404);
    const body = await res.json<{ code?: string; error?: { code?: string } }>();
    expect(body.code).toBe("PROVIDER_NOT_FOUND");
    // Not a Pithy envelope: the refusal is Better Auth's, and nothing here re-homed it.
    expect(body.error?.code).toBeUndefined();
  });

  test("nothing is recorded — a provider nobody enabled is a choice, not an incident", async () => {
    await seed(ALL_SECRETS);
    const { app, events } = buildApp({ google: { enabled: true } });
    await socialSignIn(app, "github");
    expect(events.filter((event) => event.action === "auth/provider_unavailable")).toHaveLength(0);
  });
});

describe("the healthy case is untouched", () => {
  test("enabled and provisioned still redirects to GitHub", async () => {
    await seed(ALL_SECRETS);
    const { app } = buildApp({ github: { enabled: true } });
    const res = await socialSignIn(app, "github");
    expect(res.status).toBe(200);
    expect((await res.json<{ url?: string }>()).url).toContain("github.com");
  });
});

describe("the preconditions keep failing the whole instance", () => {
  /**
   * The other half of the argument, and the half a fix like this most easily breaks. A provider is a
   * contributor; the session secret is not. Nothing signs a session without it, so degrading past it
   * would mean serving sign-in with no signing key — and the moment "one failure no longer fails
   * everything" becomes a habit rather than a judgment, that is the shape it takes.
   *
   * The status is the secrets reader's own `secrets/not_found`, unchanged by this branch, and it is
   * asserted rather than merely "not 200" so that a later change quietly turning it into a degraded
   * sign-in shows up here.
   */
  test("no session secret → magic link fails, exactly as before", async () => {
    await seed(NO_SESSION_SECRET);
    const { app } = buildApp({ github: { enabled: true } });
    const res = await magicLink(app);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("secrets/not_found");
  });

  test("no session secret → a social sign-in fails too, before any provider question is asked", async () => {
    await seed(NO_SESSION_SECRET);
    const { app } = buildApp({ github: { enabled: true } });
    const res = await socialSignIn(app, "google");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("secrets/not_found");
  });
});
