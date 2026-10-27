// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { apiKey } from "@better-auth/api-key";
import type { ArtifactsNamespaceBinding, ArtifactsRepoHandle } from "@pithy-sh/artifacts/src/binding/artifacts";
import { ARTIFACTS_MIGRATION_ORDER, artifacts } from "@pithy-sh/artifacts/src/capability";
import { artifacts_0001_init } from "@pithy-sh/artifacts/src/migrations/0001_init";
import { artifacts_0002_tokens } from "@pithy-sh/artifacts/src/migrations/0002_tokens";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, describe, expect, test } from "vitest";
import { auth } from "../capability";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { authPluginPlan } from "../migrations/pluginTables";
import {
  prepareScopedBackend,
  SCOPED_ORIGIN,
  SCOPED_REGISTRY,
  scopedWorkerEnv,
  signInScoped,
} from "../test-utils/scopedBackend";

/**
 * **An API key mints a git token, sent the way the credential helper sends it.**
 *
 * `@pithy-sh/artifacts`' credential helper is documented to work with "an API key if you compose Better Auth's
 * `apiKey()` plugin". Nothing proved it, and it was false twice over. Better Auth's plugin reads a key from
 * `x-api-key`, never from `Authorization: Bearer`, and treats one as a session only with `enableSessionForAPIKeys`.
 * And this capability's session middleware skipped every request that carried neither `authorization` nor a cookie,
 * so even a key sent where the plugin reads it never reached Better Auth. A CI job set up as the docs said got a 401
 * on every clone.
 *
 * So the helper sends a key as `x-api-key`, the middleware resolves a request that carries one, and the adopter's
 * `enableSessionForAPIKeys` stays the switch: a key the adopter never let stand for a session is refused.
 *
 * The composition is real end to end: `auth()` with the plugin, the plugin's tables migrated the way `pithy migrate`
 * makes them, the key minted over the plugin's own route, and the mint route of `artifacts()` behind its own guard.
 * Only the Artifacts binding is a stand-in, because Miniflare has none.
 */

type ApiKeyPlugin = ReturnType<typeof apiKey>;

/** A namespace answering the calls a create and a mint make. */
function namespace(): ArtifactsNamespaceBinding {
  let sequence = 0;
  const handle: ArtifactsRepoHandle = {
    createToken: async (scope = "write") => {
      sequence += 1;
      return { id: `tok_${sequence}`, plaintext: `art_v1_${sequence}`, scope, expiresAt: "2099-01-01T00:00:00.000Z" };
    },
    listTokens: async () => ({ tokens: [], total: 0 }),
    revokeToken: async () => true,
    info: async () => ({
      id: "id",
      name: "r",
      description: null,
      defaultBranch: "main",
      createdAt: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: "https://acct.artifacts.cloudflare.net/git/acme-dev/r.git",
    }),
    readBlob: async () => null,
    readTree: async () => null,
    readCommit: async () => null,
    readFile: async () => null,
    log: async () => [],
  };
  return {
    create: async (name) => ({ name, remote: "x", token: "art_v1_create", defaultBranch: "main" }),
    get: async () => handle,
    delete: async () => true,
  };
}

function buildApp(plugin: ApiKeyPlugin) {
  return createBackend({
    capabilities: [
      secrets({ registry: SCOPED_REGISTRY }),
      email({ fromAddress: "no@reply.test", fromName: "Test", baseUrl: SCOPED_ORIGIN }),
      auth({ baseURL: SCOPED_ORIGIN, basePath: "/auth", trustedOrigins: [SCOPED_ORIGIN], plugins: [plugin] }),
      artifacts(),
    ],
  });
}

type App = ReturnType<typeof buildApp>;

const binding = namespace();

function request(app: App, path: string, init: RequestInit) {
  return app.request(path, init, { ...scopedWorkerEnv(env as unknown as Record<string, unknown>), ARTIFACTS: binding });
}

/**
 * A signed-in person with a repository and an API key: the setup the credential helper's docs describe. The key is
 * minted over the plugin's own route, with the person's session, as an app would.
 */
async function setUp(plugin: ApiKeyPlugin): Promise<{ app: App; key: string; repo: string }> {
  await prepareScopedBackend(env, [
    { namespace: "authplugins", order: AUTH_MIGRATION_ORDER + 1, migrations: authPluginPlan([plugin]).migrations },
    {
      namespace: "artifacts",
      order: ARTIFACTS_MIGRATION_ORDER,
      migrations: { "0001_init": artifacts_0001_init, "0002_tokens": artifacts_0002_tokens },
    },
  ]);
  const app = buildApp(plugin);
  const { token } = await signInScoped(env.DB);
  const session = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await request(app, "/auth/api-key/create", { method: "POST", headers: session, body: "{}" });
  expect(created.status).toBe(200);
  const { key } = (await created.json()) as { key: string };
  const repo = await request(app, "/artifacts/repos", {
    method: "POST",
    headers: session,
    body: JSON.stringify({ displayName: "docs" }),
  });
  expect(repo.status).toBe(201);
  return { app, key, repo: ((await repo.json()) as { name: string }).name };
}

/** The credential helper's one request, with the app credential in `header`. */
function mint(app: App, repo: string, header: Record<string, string>) {
  return request(app, `/artifacts/repos/${repo}/credentials`, { method: "POST", headers: header });
}

afterEach(() => {
  resetSharedSecrets();
});

describe("an API key at the artifacts mint route", () => {
  test("mints a token when sent as x-api-key, with the key standing for a session", async () => {
    const { app, key, repo } = await setUp(apiKey({ enableSessionForAPIKeys: true }));
    const res = await mint(app, repo, { "x-api-key": key });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token: string }).token).toMatch(/^art_v1_/);
  });

  test("is refused as Authorization: Bearer, which Better Auth reads as a session token", async () => {
    const { app, key, repo } = await setUp(apiKey({ enableSessionForAPIKeys: true }));
    expect((await mint(app, repo, { authorization: `Bearer ${key}` })).status).toBe(401);
  });

  test("is refused when the adopter never let a key stand for a session", async () => {
    const { app, key, repo } = await setUp(apiKey());
    expect((await mint(app, repo, { "x-api-key": key })).status).toBe(401);
  });

  test("is refused when it is not a key the plugin issued", async () => {
    const { app, repo } = await setUp(apiKey({ enableSessionForAPIKeys: true }));
    expect((await mint(app, repo, { "x-api-key": "x".repeat(64) })).status).toBe(401);
  });
});

describe("the plugin's own limit on a key", () => {
  /** The statuses of `count` mints in a row with one key. */
  async function mints(plugin: ApiKeyPlugin, count: number): Promise<number[]> {
    const { app, key, repo } = await setUp(plugin);
    const statuses: number[] = [];
    for (let i = 0; i < count; i += 1) statuses.push((await mint(app, repo, { "x-api-key": key })).status);
    return statuses;
  }

  test("refuses the eleventh mint in a day by default, which a git client spends in ten operations", async () => {
    const statuses = await mints(apiKey({ enableSessionForAPIKeys: true }), 11);
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(401);
  });

  test("lets every mint through once the adopter turns the per-key limit off", async () => {
    const statuses = await mints(apiKey({ enableSessionForAPIKeys: true, rateLimit: { enabled: false } }), 11);
    expect(statuses.every((status) => status === 201)).toBe(true);
  });
});
