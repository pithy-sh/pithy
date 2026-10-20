// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { secrets_0003_reencryptions } from "@pithy-sh/secrets/src/migrations/0003_reencryptions";
import {
  fingerprintVersions,
  pendingReencryptions,
  REENCRYPTION_SETTLE_MS,
} from "@pithy-sh/secrets/src/rotation/reencryption";
import { d1VersionStore } from "@pithy-sh/secrets/src/rotation/versionStore";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { SystemSecretsStore } from "@pithy-sh/secrets/src/store/systemSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthConfig, type AuthWiring } from "../capability";
import { authDatabase } from "../data/tables";
import { signCredential, verifyCredential } from "../http/credentialResign";
import { publishSameOrigin } from "../http/csrf";
import { createSessionMiddleware } from "../http/middleware";
import { createRateLimitMiddleware } from "../http/rateLimit";
import { createAuthRoutes } from "../http/routes";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { type AuthEmailMessage, makeAuth } from "./auth";
import { resetJwksReencryption } from "./jwksReencryption";
import { NO_SOCIAL_PROVIDERS } from "./providers";
import { AUTH_JWKS_DEPENDENT, AUTH_SESSION_SECRET, authSecretsRegistry } from "./secrets";
import type { SessionSecretVersions } from "./sessionSecrets";

/**
 * **`auth-session-secret` rotates and nobody is signed out (#602).**
 *
 * The real stack, end to end: a session signed in under version 1, the secret rotated to version 2 the way
 * the secrets manager rotates it, and a request made with the old cookie. Then the JWKS keys: sealed under
 * version 1, moved by a request once every reader's cache has caught up, version 1 retired, and a JWT signed.
 */

const OLD = "session-secret-version-one-0000000000000000";
const NEW = "session-secret-version-two-0000000000000000";
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

const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": OLD,
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

function wiring(): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({ baseURL: "http://localhost", basePath: "/auth", trustedOrigins: ["http://localhost"] }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
  };
}

/** The capability's middleware and routes, in the capability's order. */
function app(): Hono<PithyHonoEnv> {
  const built = new Hono<PithyHonoEnv>();
  const w = wiring();
  built.onError(pithyErrorHandler);
  built.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(w)(built);
  built.use(`${w.config.basePath}/*`, createRateLimitMiddleware(w.config.rateLimiterBinding));
  createSessionMiddleware(w)(built);
  createAuthRoutes(w)(built);
  return built;
}

/** An instance outside a request, over the same database — under one secret, or under a version set. */
function instance(secret: string, sessionSecrets?: SessionSecretVersions) {
  const mailbox: AuthEmailMessage[] = [];
  return {
    mailbox,
    auth: makeAuth({
      db: authDatabase(env.DB),
      secret,
      ...(sessionSecrets === undefined ? {} : { sessionSecrets }),
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      ...NO_SOCIAL_PROVIDERS,
      sendEmail: async (message) => {
        mailbox.push(message);
        return { delivery: "queued" };
      },
      sessionExpiresIn: 604800,
      sessionUpdateAge: 86400,
      verificationExpiresIn: 300,
      otpLength: 6,
      disableSignUp: false,
      providerSignUp: { google: true, apple: true, facebook: true, github: true, microsoft: true },
      emit: noopEmit,
      plugins: [],
    }),
  };
}

/** Sign in under version 1 and return the session cookie Better Auth set, exactly as a browser holds it. */
async function signIn(): Promise<{ name: string; value: string; token: string }> {
  const { auth, mailbox } = instance(OLD);
  await auth.api.sendVerificationOTP({ body: { email: "u@test.com", type: "sign-in" }, headers: new Headers() });
  const otp = mailbox.find((message) => message.template === "otp");
  if (otp?.template !== "otp") throw new Error("no OTP");
  const response = await auth.api.signInEmailOTP({
    body: { email: "u@test.com", otp: otp.code },
    headers: new Headers(),
    asResponse: true,
  });
  const line = response.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  if (!line) throw new Error("no session cookie");
  const pair = line.split(";")[0] as string;
  const name = pair.slice(0, pair.indexOf("="));
  const value = pair.slice(pair.indexOf("=") + 1);
  const token = decodeURIComponent(value).split(".")[0] as string;
  return { name, value, token };
}

/** The manager's first write: version 2 beside version 1, which stays current. What an isolate refreshed since holds. */
async function stage(): Promise<void> {
  await d1VersionStore(await SystemSecretsStore.fromEnv(env), "text").stage(AUTH_SESSION_SECRET, NEW);
  // The shared accessor caches for a minute; a Worker sees the new version within that TTL.
  resetSharedSecrets();
  configureSharedSecrets({ registry: authSecretsRegistry });
}

/** Rotate the session secret the way the manager does: stage version 2, then make it current, keeping version 1. */
async function rotate(): Promise<void> {
  const store = d1VersionStore(await SystemSecretsStore.fromEnv(env), "text");
  await store.promote(AUTH_SESSION_SECRET, await store.stage(AUTH_SESSION_SECRET, NEW));
  resetSharedSecrets();
  configureSharedSecrets({ registry: authSecretsRegistry });
}

/** Retire version 1, as the manager does once the overlap has passed and the JWKS keys have moved. */
async function retire(): Promise<void> {
  await d1VersionStore(await SystemSecretsStore.fromEnv(env), "text").retire(AUTH_SESSION_SECRET, ["1"]);
  resetSharedSecrets();
  configureSharedSecrets({ registry: authSecretsRegistry });
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: authSecretsRegistry });
  await seedSecrets(env, authSecretsRegistry, SECRETS);
  await env.SECRETS.prepare("drop table if exists pithy_secrets_reencryptions").run();
  await secrets_0003_reencryptions.up(createDatabase(env.SECRETS, secretsTables) as never);
  resetJwksReencryption();
});

afterEach(() => {
  resetSharedSecrets();
  resetJwksReencryption();
});

describe("a session signed before the rotation, used after it", () => {
  test("signs in, rotates, and makes an authenticated request with the old cookie — re-signed on the way back", async () => {
    const cookie = await signIn();
    await rotate();

    const response = await app().request(
      "/auth/devices",
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
      appEnv(),
    );
    expect(response.status).toBe(200);

    // The response hands back the same session, signed under version 2.
    const line = response.headers.getSetCookie().find((one) => one.startsWith(`${cookie.name}=`));
    if (!line) throw new Error("expected the re-signed session cookie");
    const fresh = decodeURIComponent(line.slice(cookie.name.length + 1, line.indexOf(";")));
    expect(await verifyCredential(fresh, [NEW])).toEqual({ value: cookie.token, key: 0 });
    expect(line).toContain("HttpOnly");

    // And the re-signed cookie works on its own.
    const again = await app().request(
      "/auth/devices",
      { headers: { cookie: `${cookie.name}=${encodeURIComponent(fresh)}` } },
      appEnv(),
    );
    expect(again.status).toBe(200);
  });

  test("an isolate still holding the staged envelope accepts a cookie another isolate signed under version 2", async () => {
    // The cross-isolate window: version 2 is current where the cache refreshed after the promotion, and this
    // isolate's cache is from between the two writes. It holds version 2 as a verifying key, so the cookie is
    // carried to the version it signs under rather than refused.
    const cookie = await signIn();
    await stage();
    const signedUnderNew = encodeURIComponent(await signCredential(cookie.token, NEW));
    const response = await app().request(
      "/auth/devices",
      { headers: { cookie: `${cookie.name}=${signedUnderNew}` } },
      appEnv(),
    );
    expect(response.status).toBe(200);
  });

  test("a bearer client holding the signed token is carried across too, and told its new one", async () => {
    const cookie = await signIn();
    await rotate();
    const response = await app().request(
      "/auth/devices",
      { headers: { authorization: `Bearer ${cookie.value}` } },
      appEnv(),
    );
    expect(response.status).toBe(200);
    const fresh = decodeURIComponent(response.headers.get("set-auth-token") ?? "");
    expect(await verifyCredential(fresh, [NEW])).toEqual({ value: cookie.token, key: 0 });
  });

  test("once version 1 is retired, a cookie signed under it is refused — the overlap is the window, not forever", async () => {
    const cookie = await signIn();
    await rotate();
    await retire();
    const response = await app().request(
      "/auth/devices",
      { headers: { cookie: `${cookie.name}=${cookie.value}` } },
      appEnv(),
    );
    expect(response.status).toBe(401);
  });

  test("a cookie signed under no version this deployment holds is refused, rotation or not", async () => {
    const cookie = await signIn();
    await rotate();
    const forged = encodeURIComponent(await signCredential(cookie.token, "never-held-by-anyone-00000000000000000000"));
    const response = await app().request(
      "/auth/devices",
      { headers: { cookie: `${cookie.name}=${forged}` } },
      appEnv(),
    );
    expect(response.status).toBe(401);
  });
});

describe("the JWKS keys sealed under the session secret", () => {
  test("rotates, retires, and signs a JWT: a request after the settling window moves the keys", async () => {
    // A key sealed before the kit handed Better Auth a version set: bare ciphertext under version 1.
    await instance(OLD).auth.api.signJWT({ body: { payload: { sub: "before" } } });
    await rotate();
    const secretsDb = createDatabase(env.SECRETS, secretsTables);
    const fingerprints = await fingerprintVersions({ "1": OLD, "2": NEW });
    const pending = () =>
      pendingReencryptions(secretsDb, AUTH_SESSION_SECRET, [AUTH_JWKS_DEPENDENT], "2", fingerprints);
    expect(await pending()).toEqual([AUTH_JWKS_DEPENDENT]);
    const privateKey = async () =>
      JSON.parse(
        (await env.DB.prepare("select private_key from pithy_auth_jwks").first<{ private_key: string }>())
          ?.private_key ?? '""',
      ) as string;

    // The first request after the rotation records that it saw version 2, and moves nothing yet: another
    // isolate may still hold the envelope it cached before the append, with no key for version 2.
    expect((await app().request("/auth/jwks", {}, appEnv())).status).toBe(200);
    expect(await privateKey()).not.toMatch(/^\$ba\$2\$/);
    expect(await pending()).toEqual([`${AUTH_JWKS_DEPENDENT}/DB`]);

    // Once every cache filled before the append has expired, the next request moves the keys and records it.
    await env.SECRETS.prepare("update pithy_secrets_reencryptions set observed_at = observed_at - ?")
      .bind(REENCRYPTION_SETTLE_MS)
      .run();
    resetJwksReencryption();
    expect((await app().request("/auth/jwks", {}, appEnv())).status).toBe(200);
    expect(await privateKey()).toMatch(/^\$ba\$2\$/);
    expect(await pending()).toEqual([]);

    // Retirement may now proceed, and a JWT still signs with only version 2 held.
    await retire();
    const current = { currentVersion: "2", versions: { "2": NEW } };
    const { token } = await instance(NEW, current).auth.api.signJWT({ body: { payload: { sub: "after" } } });
    expect(token.split(".")).toHaveLength(3);
    const verified = await instance(NEW, current).auth.api.verifyJWT({ body: { token } });
    expect(verified.payload?.sub).toBe("after");
  });

  test("without the move, retiring version 1 would strand the key — which is what the wait prevents", async () => {
    await instance(OLD).auth.api.signJWT({ body: { payload: { sub: "before" } } });
    await rotate();
    await retire();
    const current = { currentVersion: "2", versions: { "2": NEW } };
    await expect(instance(NEW, current).auth.api.signJWT({ body: { payload: { sub: "after" } } })).rejects.toThrow(
      /decrypt/i,
    );
  });
});
