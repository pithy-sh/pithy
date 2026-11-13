// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { type SecretFixture, seedSecrets } from "@pithy-sh/secrets/src/test-utils/secretFixtures";
import { turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { issueChallenge } from "../attestation/challenge";
import type { AttestationVerification, AttestationVerifiers } from "../attestation/verifier";
import { ATTESTATION_TEST_ASSERTION } from "../attestation/verifier";
import { ATTESTATION_HEADER, encodeAttestation, type PresentedAttestation, requestBinding } from "../attestation/wire";
import { AuthConfig, type AuthConfigInput, type AuthWiring, type TurnstileLoginGate } from "../capability";
import { authDatabase } from "../data/tables";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { AttestationChallengeResponse } from "./responses";
import { createAuthRoutes } from "./routes";

const REGISTRY = { ...authSecretsRegistry, ...turnstileSecretsRegistry };
const SECRETS: SecretFixture<typeof REGISTRY> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
  "turnstile-secret-keys": { visible: { key: "1x0000000000000000000000000000000AA" } },
};

const IOS_APP = { teamId: "ABCDE12345", bundleId: "com.example.app" };
const TURNSTILE: TurnstileLoginGate = { mode: "visible", token: { field: "cf-turnstile-response" } };

/**
 * The blocks most cases run under: staging set to test, and prod and the declared `live` set to test too, so their
 * refusal is the Worker's own.
 */
const ATTESTATION: AuthConfigInput["attestation"] = {
  environments: {
    staging: { mode: "test", ios: [IOS_APP] },
    prod: { mode: "test", ios: [IOS_APP] },
    live: { mode: "test", ios: [IOS_APP] },
    qa: { mode: "enforce", ios: [IOS_APP] },
  },
};

/** The two send routes, with a body each accepts. */
const SEND_ROUTES: [string, Record<string, string>][] = [
  ["/auth/sign-in/magic-link", { email: "link@test.com" }],
  ["/auth/email-otp/send-verification-otp", { email: "otp@test.com", type: "sign-in" }],
];

function wiring(
  options: {
    turnstile?: TurnstileLoginGate;
    attestation?: AuthConfigInput["attestation"];
    verifiers?: AttestationVerifiers;
  } = {},
): AuthWiring {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  return {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      attestation: options.attestation ?? ATTESTATION,
    }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: emailCap.enqueue,
    turnstile: options.turnstile,
    attestationVerifiers: options.verifiers ?? {},
  };
}

function app(built: AuthWiring): Hono<PithyHonoEnv> {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  hono.use("*", async (c, next) => {
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("auth") === undefined) c.set("auth", null);
    await next();
  });
  publishSameOrigin(built)(hono);
  createSessionMiddleware(built)(hono);
  createAuthRoutes(built)(hono);
  return hono;
}

function appEnv(environment: string | null): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...(environment === null ? {} : { ENVIRONMENT: environment }),
  };
}

async function challenge(hono: Hono<PithyHonoEnv>, environment = "staging"): Promise<string> {
  const res = await hono.request("/auth/attestation/challenge", { method: "POST" }, appEnv(environment));
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

function send(
  hono: Hono<PithyHonoEnv>,
  path: string,
  body: Record<string, string>,
  options: { environment?: string | null; attestation?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    hono.request(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.attestation === undefined ? {} : { [ATTESTATION_HEADER]: options.attestation }),
        },
        body: JSON.stringify(body),
      },
      appEnv(options.environment === undefined ? "staging" : options.environment),
    ),
  );
}

function testAttestation(challengeValue: string, platform: "ios" | "android" = "ios"): string {
  return encodeAttestation({ platform, challenge: challengeValue, assertion: ATTESTATION_TEST_ASSERTION });
}

async function refusal(res: Response): Promise<{ status: number; code: string }> {
  return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
}

beforeEach(async () => {
  for (const row of (
    await env.DB.prepare("select name from sqlite_master where type = 'table' and name like 'pithy_%'").all<{
      name: string;
    }>()
  ).results) {
    await env.DB.prepare(`drop table if exists ${row.name}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
  configureSharedSecrets({ registry: REGISTRY });
  await seedSecrets(env, REGISTRY, SECRETS);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("the attestation challenge route", () => {
  test("returns a nonce and when it stops working", async () => {
    const res = await app(wiring()).request("/auth/attestation/challenge", { method: "POST" }, appEnv("staging"));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(AttestationChallengeResponse.parse(body)).toEqual(body);
    const { challenge: value, expiresAt } = AttestationChallengeResponse.parse(body);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(290_000);
  });

  test("is refused with auth/attestation_config in an environment with no block", async () => {
    const res = await app(wiring()).request("/auth/attestation/challenge", { method: "POST" }, appEnv("dev"));
    expect(await refusal(res)).toEqual({ status: 500, code: "auth/attestation_config" });
  });

  test("is not mounted at all when no environment has a block", async () => {
    const res = await app(wiring({ attestation: {} })).request(
      "/auth/attestation/challenge",
      { method: "POST" },
      appEnv("staging"),
    );
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(500);
  });
});

describe.each(SEND_ROUTES)("the attestation gate on %s", (path, body) => {
  test("a valid test attestation in a test environment passes with no Turnstile token, turnstile composed", async () => {
    const hono = app(wiring({ turnstile: TURNSTILE }));
    const res = await send(hono, path, body, { attestation: testAttestation(await challenge(hono)) });
    expect(res.status).toBe(200);
    const job = await env.DB.prepare("select count(*) as n from pithy_email_jobs where to_address = ?")
      .bind(body.email)
      .first<{ n: number }>();
    expect(job?.n).toBe(1);
  });

  test("the test assertion passes from android too", async () => {
    const hono = app(wiring());
    const res = await send(hono, path, body, { attestation: testAttestation(await challenge(hono), "android") });
    expect(res.status).toBe(200);
  });

  test("a second use of the challenge is refused with auth/attestation_failed", async () => {
    const hono = app(wiring());
    const value = await challenge(hono);
    expect((await send(hono, path, body, { attestation: testAttestation(value) })).status).toBe(200);
    expect(await refusal(await send(hono, path, body, { attestation: testAttestation(value) }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("a challenge used after it expires is refused with auth/attestation_failed", async () => {
    const hono = app(wiring());
    const stale = await issueChallenge(authDatabase(env.DB), { now: new Date(Date.now() - 600_000), expiresIn: 300 });
    expect(await refusal(await send(hono, path, body, { attestation: testAttestation(stale.challenge) }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("a challenge nobody issued is refused with auth/attestation_failed", async () => {
    const hono = app(wiring());
    expect(await refusal(await send(hono, path, body, { attestation: testAttestation("x".repeat(43)) }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("an attestation that fails is refused with auth/attestation_failed and never reaches Turnstile", async () => {
    const hono = app(
      wiring({
        turnstile: TURNSTILE,
        verifiers: { ios: { verify: async () => ({ ok: false, reason: "bad signature" }) } },
      }),
    );
    const attestation = encodeAttestation({ platform: "ios", challenge: await challenge(hono), assertion: "real" });
    expect(await refusal(await send(hono, path, body, { attestation }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("a header that does not decode is refused with auth/attestation_failed, turnstile composed", async () => {
    const hono = app(wiring({ turnstile: TURNSTILE }));
    expect(await refusal(await send(hono, path, body, { attestation: "%%%" }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("no attestation goes through Turnstile when turnstile is composed", async () => {
    const hono = app(wiring({ turnstile: TURNSTILE }));
    expect(await refusal(await send(hono, path, body))).toEqual({ status: 400, code: "turnstile/missing_token" });
  });

  test("no attestation, no turnstile and a block for this environment is refused with auth/attestation_missing", async () => {
    expect(await refusal(await send(app(wiring()), path, body))).toEqual({
      status: 400,
      code: "auth/attestation_missing",
    });
  });

  test("no attestation and no turnstile in an environment with no block passes, as it did before", async () => {
    expect((await send(app(wiring()), path, body, { environment: "dev" })).status).toBe(200);
  });

  test("the test assertion is refused in prod even though prod's block says test", async () => {
    const hono = app(wiring());
    const value = await challenge(hono, "prod");
    expect(
      await refusal(await send(hono, path, body, { environment: "prod", attestation: testAttestation(value) })),
    ).toEqual({ status: 403, code: "auth/attestation_failed" });
  });

  test("the test assertion is refused in a declared environment whose block says test", async () => {
    const hono = app(wiring());
    const value = await challenge(hono, "live");
    expect(
      await refusal(await send(hono, path, body, { environment: "live", attestation: testAttestation(value) })),
    ).toEqual({ status: 403, code: "auth/attestation_failed" });
  });

  test("the test assertion is refused in an environment set to enforce", async () => {
    const hono = app(wiring());
    const value = await challenge(hono, "qa");
    expect(
      await refusal(await send(hono, path, body, { environment: "qa", attestation: testAttestation(value) })),
    ).toEqual({ status: 403, code: "auth/attestation_failed" });
  });

  test("a real assertion for a platform with no verifier is refused with auth/attestation_config", async () => {
    const hono = app(wiring());
    const value = await challenge(hono, "qa");
    const attestation = encodeAttestation({ platform: "ios", challenge: value, assertion: "real" });
    expect(await refusal(await send(hono, path, body, { environment: "qa", attestation }))).toEqual({
      status: 500,
      code: "auth/attestation_config",
    });
  });

  test("a real assertion from a platform with no allowed app is refused with auth/attestation_failed", async () => {
    const hono = app(wiring({ verifiers: { android: { verify: async () => ({ ok: true }) } } }));
    const value = await challenge(hono, "qa");
    const attestation = encodeAttestation({ platform: "android", challenge: value, assertion: "real" });
    expect(await refusal(await send(hono, path, body, { environment: "qa", attestation }))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test("an attestation in an environment with no block is refused with auth/attestation_config", async () => {
    const hono = app(wiring());
    const value = await challenge(hono);
    expect(
      await refusal(await send(hono, path, body, { environment: "dev", attestation: testAttestation(value) })),
    ).toEqual({ status: 500, code: "auth/attestation_config" });
  });

  test("a verifier is handed the binding over the challenge and the exact body, and the body still reaches Better Auth", async () => {
    const seen: AttestationVerification[] = [];
    const hono = app(
      wiring({
        verifiers: {
          ios: {
            verify: async (verification) => {
              seen.push(verification);
              return { ok: true };
            },
          },
        },
      }),
    );
    const presented: PresentedAttestation = {
      platform: "ios",
      challenge: await challenge(hono, "qa"),
      assertion: "real",
      keyId: "key-1",
    };
    const res = await send(hono, path, body, { environment: "qa", attestation: encodeAttestation(presented) });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.presented).toEqual(presented);
    expect(seen[0]?.environment).toBe("qa");
    expect(seen[0]?.binding).toEqual(
      await requestBinding(presented.challenge, new TextEncoder().encode(JSON.stringify(body))),
    );
  });

  test("a verifier is handed the Worker's bindings, so it can read a secret from auth's registry", async () => {
    const seen: AttestationVerification[] = [];
    const hono = app(
      wiring({
        verifiers: {
          ios: {
            verify: async (verification) => {
              seen.push(verification);
              return { ok: true };
            },
          },
        },
      }),
    );
    const attestation = encodeAttestation({
      platform: "ios",
      challenge: await challenge(hono, "qa"),
      assertion: "real",
    });
    const res = await send(hono, path, body, { environment: "qa", attestation });
    expect(res.status).toBe(200);
    expect(seen[0]?.env.ENVIRONMENT).toBe("qa");
    expect(seen[0]?.env.AUTH_RATE_LIMITER).toBeDefined();
  });
});
