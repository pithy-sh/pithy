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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PLATFORM_VERIFIERS } from "../attestation/verifier";
import { ATTESTATION_HEADER, encodeAttestation, requestBinding } from "../attestation/wire";
import { AuthConfig, type AuthConfigInput, type AuthWiring } from "../capability";
import { authSecretsRegistry } from "../instance/secrets";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { type AppAttestAuthority, type AttestedKey, appAttestAuthority } from "../test-utils/appAttestDevice";
import { publishSameOrigin } from "./csrf";
import { createSessionMiddleware } from "./middleware";
import { AppAttestKeyResponse } from "./responses";
import { createAuthRoutes } from "./routes";

const SECRETS: SecretFixture<typeof authSecretsRegistry> = {
  "auth-session-secret": "test-secret-please-rotate-0000000000",
  "auth-google-credentials": { clientId: "g", clientSecret: "g" },
  "auth-apple-credentials": { clientId: "a", clientSecret: "a" },
  "auth-facebook-credentials": { clientId: "f", clientSecret: "f" },
  "auth-github-credentials": { clientId: "h", clientSecret: "h" },
};

const IOS_APP = { teamId: "ABCDE12345", bundleId: "com.example.app" };
const APP_ID = `${IOS_APP.teamId}.${IOS_APP.bundleId}`;
const ATTESTATION: AuthConfigInput["attestation"] = {
  environments: { prod: { ios: [IOS_APP] }, staging: { ios: [IOS_APP] } },
};
const SEND = "/auth/sign-in/magic-link";
const BODY = JSON.stringify({ email: "ios@test.com" });

let authority: AppAttestAuthority;

/** The app under test, trusting the fake authority's root, or with `"apple"`, the pinned one as deployed. */
function app(root: Uint8Array | "apple" = authority.root): Hono<PithyHonoEnv> {
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
    appAttestRoot: root === "apple" ? undefined : root,
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

function appEnv(environment: string): Record<string, unknown> {
  return {
    ...(env as unknown as Record<string, unknown>),
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ENVIRONMENT: environment,
  };
}

async function challenge(hono: Hono<PithyHonoEnv>, environment = "prod"): Promise<string> {
  const res = await hono.request("/auth/attestation/challenge", { method: "POST" }, appEnv(environment));
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

function registerKey(
  hono: Hono<PithyHonoEnv>,
  body: { challenge: string; keyId: string; attestation: string },
  environment = "prod",
): Promise<Response> {
  return Promise.resolve(
    hono.request(
      "/auth/attestation/ios/keys",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      appEnv(environment),
    ),
  );
}

/** Attest a fresh key over a fresh challenge, the way the app does before registering it. */
async function attest(
  hono: Hono<PithyHonoEnv>,
  options: { appId?: string; environment?: "production" | "development"; worker?: string } = {},
): Promise<{ key: AttestedKey; challenge: string }> {
  const value = await challenge(hono, options.worker);
  const key = await authority.attest({
    appId: options.appId ?? APP_ID,
    clientDataHash: await requestBinding(value, new Uint8Array(0)),
    environment: options.environment,
  });
  return { key, challenge: value };
}

async function registered(hono: Hono<PithyHonoEnv>): Promise<AttestedKey> {
  const { key, challenge: value } = await attest(hono);
  const res = await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation });
  expect(res.status).toBe(200);
  return key;
}

/** Send the magic link with an assertion by `key` over a fresh challenge and this exact body. */
async function send(
  hono: Hono<PithyHonoEnv>,
  key: AttestedKey,
  options: { counter: number; appId?: string; keyId?: string; challenge?: string; signBody?: string },
): Promise<Response> {
  const value = options.challenge ?? (await challenge(hono));
  const binding = await requestBinding(value, new TextEncoder().encode(options.signBody ?? BODY));
  const assertion = await key.assert({
    appId: options.appId ?? APP_ID,
    clientDataHash: binding,
    counter: options.counter,
  });
  const header = encodeAttestation({ platform: "ios", challenge: value, assertion, keyId: options.keyId ?? key.keyId });
  return hono.request(
    SEND,
    { method: "POST", headers: { "content-type": "application/json", [ATTESTATION_HEADER]: header }, body: BODY },
    appEnv("prod"),
  );
}

async function refusal(res: Response): Promise<{ status: number; code: string }> {
  return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
}

const FAILED = { status: 403, code: "auth/attestation_failed" };

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
  await seedSecrets(env, authSecretsRegistry, SECRETS);
  authority = await appAttestAuthority();
});

afterEach(() => {
  resetSharedSecrets();
});

describe("App Attest is the iOS verifier this release ships", () => {
  test("PLATFORM_VERIFIERS carries it for ios", () => {
    expect(PLATFORM_VERIFIERS.ios).toBeDefined();
  });
});

describe("POST /auth/attestation/ios/keys", () => {
  test("registers a key whose attestation verifies", async () => {
    const hono = app();
    const { key, challenge: value } = await attest(hono);
    const res = await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(AppAttestKeyResponse.parse(body)).toEqual(body);
    expect(AppAttestKeyResponse.parse(body).keyId).toBe(key.keyId);
    const row = await env.DB.prepare("select app_id, counter, environment from pithy_auth_app_attest_keys").first();
    expect(row).toEqual({ app_id: APP_ID, counter: 0, environment: "production" });
  });

  test("refuses a wrong chain: Apple's pinned root does not lead to another authority's leaf", async () => {
    const hono = app("apple");
    const { key, challenge: value } = await attest(hono);
    const res = await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation });
    expect(await refusal(res)).toEqual(FAILED);
  });

  test("refuses a wrong rpIdHash: a key attested for another app", async () => {
    const hono = app();
    const { key, challenge: value } = await attest(hono, { appId: "ABCDE12345.com.example.impostor" });
    expect(
      await refusal(await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation })),
    ).toEqual(FAILED);
  });

  test("refuses a reused challenge", async () => {
    const hono = app();
    const { key, challenge: value } = await attest(hono);
    expect((await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation })).status).toBe(
      200,
    );
    const second = await authority.attest({
      appId: APP_ID,
      clientDataHash: await requestBinding(value, new Uint8Array(0)),
    });
    expect(
      await refusal(
        await registerKey(hono, { challenge: value, keyId: second.keyId, attestation: second.attestation }),
      ),
    ).toEqual(FAILED);
  });

  test("refuses a development AAGUID in production", async () => {
    const hono = app();
    const { key, challenge: value } = await attest(hono, { environment: "development" });
    expect(
      await refusal(await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation })),
    ).toEqual(FAILED);
  });

  test("accepts a development AAGUID in staging", async () => {
    const hono = app();
    const { key, challenge: value } = await attest(hono, { environment: "development", worker: "staging" });
    const res = await registerKey(
      hono,
      { challenge: value, keyId: key.keyId, attestation: key.attestation },
      "staging",
    );
    expect(res.status).toBe(200);
  });

  test("refuses registering the same key twice, so its counter cannot be reset", async () => {
    const hono = app();
    const key = await registered(hono);
    const value = await challenge(hono);
    expect(
      await refusal(await registerKey(hono, { challenge: value, keyId: key.keyId, attestation: key.attestation })),
    ).toEqual(FAILED);
  });

  test("refuses a body without the fields, before spending anything", async () => {
    const res = await app().request(
      "/auth/attestation/ios/keys",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      appEnv("prod"),
    );
    expect(res.status).toBe(400);
  });

  test("answers auth/attestation_config in an environment with no block", async () => {
    const res = await registerKey(app(), { challenge: "c", keyId: "k", attestation: "a" }, "dev");
    expect(await refusal(res)).toEqual({ status: 500, code: "auth/attestation_config" });
  });
});

describe("an App Attest assertion on a send route", () => {
  test("verifies, and the send goes through without Turnstile", async () => {
    const hono = app();
    const key = await registered(hono);
    expect((await send(hono, key, { counter: 1 })).status).toBe(200);
    expect((await send(hono, key, { counter: 2 })).status).toBe(200);
    const row = await env.DB.prepare("select counter, last_used_at from pithy_auth_app_attest_keys").first<{
      counter: number;
      last_used_at: number | null;
    }>();
    expect(row?.counter).toBe(2);
    expect(row?.last_used_at).not.toBeNull();
  });

  test("refuses an unknown key", async () => {
    const hono = app();
    const unregistered = (await attest(hono)).key;
    expect(await refusal(await send(hono, unregistered, { counter: 1 }))).toEqual(FAILED);
  });

  test("refuses a bad signature: another key's, presented under this key's id", async () => {
    const hono = app();
    const key = await registered(hono);
    const impostor = (await attest(hono)).key;
    expect(await refusal(await send(hono, impostor, { counter: 1, keyId: key.keyId }))).toEqual(FAILED);
  });

  test("refuses a bad signature: made over another body", async () => {
    const hono = app();
    const key = await registered(hono);
    const res = await send(hono, key, { counter: 1, signBody: JSON.stringify({ email: "other@test.com" }) });
    expect(await refusal(res)).toEqual(FAILED);
  });

  test("refuses a wrong rpIdHash", async () => {
    const hono = app();
    const key = await registered(hono);
    expect(await refusal(await send(hono, key, { counter: 1, appId: "ABCDE12345.com.example.other" }))).toEqual(FAILED);
  });

  test("refuses a counter that does not increase", async () => {
    const hono = app();
    const key = await registered(hono);
    expect((await send(hono, key, { counter: 5 })).status).toBe(200);
    expect(await refusal(await send(hono, key, { counter: 5 }))).toEqual(FAILED);
    expect(await refusal(await send(hono, key, { counter: 4 }))).toEqual(FAILED);
  });

  test("refuses a reused challenge, even with a fresh assertion over it", async () => {
    const hono = app();
    const key = await registered(hono);
    const value = await challenge(hono);
    expect((await send(hono, key, { counter: 1, challenge: value })).status).toBe(200);
    expect(await refusal(await send(hono, key, { counter: 2, challenge: value }))).toEqual(FAILED);
  });
});
