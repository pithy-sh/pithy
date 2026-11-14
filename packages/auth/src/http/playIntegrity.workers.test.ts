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
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPlayIntegrityVerifier } from "../attestation/playIntegrity/verifier";
import { PLATFORM_VERIFIERS } from "../attestation/verifier";
import { ATTESTATION_HEADER, encodeAttestation, requestBinding } from "../attestation/wire";
import { AuthConfig, type AuthConfigInput, type AuthWiring } from "../capability";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { googleFetch, passingDecode, type TestServiceAccount, testServiceAccount } from "../test-utils/googlePlay";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { createAuthRoutes } from "./routes";

const PACKAGE = "com.example.app";
const ATTESTATION: AuthConfigInput["attestation"] = {
  environments: { prod: { android: [{ packageName: PACKAGE }] } },
};
const SEND = "/auth/sign-in/magic-link";
const BODY = JSON.stringify({ email: "android@test.com" });

let sample: TestServiceAccount;

beforeAll(async () => {
  sample = await testServiceAccount();
});

function app(fetchImpl: typeof fetch): Hono<PithyHonoEnv> {
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: "http://localhost" });
  const built: AuthWiring = {
    config: AuthConfig.parse({
      baseURL: "http://localhost",
      basePath: "/auth",
      trustedOrigins: ["http://localhost"],
      attestation: ATTESTATION,
    }),
    resolveGithubUserInfo: undefined,
    enqueueEmail: emailCap.enqueue,
    turnstile: undefined,
    attestationVerifiers: { android: createPlayIntegrityVerifier({ fetch: fetchImpl }) },
  };
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

function appEnv(): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ENVIRONMENT: "prod",
  };
}

async function challenge(hono: Hono<PithyHonoEnv>): Promise<string> {
  const res = await hono.request("/auth/attestation/challenge", { method: "POST" }, appEnv());
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

function send(hono: Hono<PithyHonoEnv>, value: string): Promise<Response> {
  const header = encodeAttestation({ platform: "android", challenge: value, assertion: "integrity-token" });
  return Promise.resolve(
    hono.request(
      SEND,
      { method: "POST", headers: { "content-type": "application/json", [ATTESTATION_HEADER]: header }, body: BODY },
      appEnv(),
    ),
  );
}

async function refusal(res: Response): Promise<{ status: number; code: string }> {
  return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
}

/** A Google that decodes every token as a pass bound to whatever the latest challenge's binding was. */
function bindingGoogle(binding: () => Uint8Array) {
  return googleFetch({ decode: () => passingDecode(binding(), new Date(), PACKAGE) });
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
  configureSharedSecrets({ registry: authSecretsRegistry });
  const secrets: SecretFixture<typeof authSecretsRegistry> = {
    "auth-session-secret": "test-secret-please-rotate-0000000000",
    "auth-play-integrity-service-account": sample.account,
  };
  await seedSecrets(env, authSecretsRegistry, secrets);
});

afterEach(() => {
  resetSharedSecrets();
});

describe("a Play Integrity token on a send route", () => {
  test("PLATFORM_VERIFIERS carries it for android", () => {
    expect(PLATFORM_VERIFIERS.android).toBeDefined();
  });

  test("passes when Google decodes a verdict bound to this challenge and body, with the account from auth's secrets", async () => {
    let binding: Uint8Array = new Uint8Array(32);
    const google = bindingGoogle(() => binding);
    const hono = app(google.fetch);
    const value = await challenge(hono);
    binding = await requestBinding(value, new TextEncoder().encode(BODY));
    expect((await send(hono, value)).status).toBe(200);
    const job = await env.DB.prepare("select count(*) as n from pithy_email_jobs where to_address = ?")
      .bind("android@test.com")
      .first<{ n: number }>();
    expect(job?.n).toBe(1);
  });

  test("a reused challenge is refused with auth/attestation_failed before Google is asked", async () => {
    let binding: Uint8Array = new Uint8Array(32);
    const google = bindingGoogle(() => binding);
    const hono = app(google.fetch);
    const value = await challenge(hono);
    binding = await requestBinding(value, new TextEncoder().encode(BODY));
    expect((await send(hono, value)).status).toBe(200);
    const calls = google.seen.length;
    expect(await refusal(await send(hono, value))).toEqual({ status: 403, code: "auth/attestation_failed" });
    expect(google.seen).toHaveLength(calls);
  });

  test("a token bound to another challenge is refused with auth/attestation_failed", async () => {
    const google = bindingGoogle(() => new Uint8Array(32).fill(3));
    const hono = app(google.fetch);
    expect(await refusal(await send(hono, await challenge(hono)))).toEqual({
      status: 403,
      code: "auth/attestation_failed",
    });
  });

  test.each([401, 403])("Google answering %i is auth/attestation_config, not the user's fault", async (status) => {
    const google = googleFetch({ decode: { status, body: { error: { message: "denied" } } } });
    const hono = app(google.fetch);
    expect(await refusal(await send(hono, await challenge(hono)))).toEqual({
      status: 500,
      code: "auth/attestation_config",
    });
  });

  test("no service account stored is auth/attestation_config", async () => {
    await env.SECRETS.prepare("delete from pithy_secrets_system_secrets where name = ?")
      .bind("auth-play-integrity-service-account")
      .run();
    configureSharedSecrets({ registry: authSecretsRegistry });
    const google = googleFetch({});
    const hono = app(google.fetch);
    const res = await send(hono, await challenge(hono));
    expect(await refusal(res)).toEqual({ status: 500, code: "auth/attestation_config" });
    expect(google.seen).toHaveLength(0);
  });
});
