// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { EncryptionConfig } from "../crypto/envelope";
import { secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import { defineSecretRegistry } from "../registry";
import { secretsStore } from "../secretsStore";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { DevSecretEnvelope } from "./devSecretsFile";
import { loadDevSecrets } from "./loadDevSecrets";
import { seedDevSecrets } from "./seedDevSecrets";

/**
 * The seam that matters: what the seeder writes is what a deployed read finds. The double in the node
 * suite proves the routing; this proves the row — real D1, real AES-256-GCM envelope, real master key —
 * so "in exactly the shape a provisioned secret has" is a fact and not a comment.
 */

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": keyB64() },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-google-credentials": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: z
      .object({
        clientId: z.string().describe("The OAuth client id."),
        clientSecret: z.string().describe("The OAuth client secret."),
      })
      .describe("A Google OAuth application's credentials."),
  },
});

function store(): SystemSecretsStore {
  return new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), config);
}

/** A deployed env, so the reader routes by backend and `d1` comes strictly from the seeded rows. */
function deployedEnv(): SecretsStoreEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: JSON.stringify(config),
    ENVIRONMENT: "prod",
  } as unknown as SecretsStoreEnv;
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("seedDevSecrets against a real SECRETS D1", () => {
  test("a seeded row reads back through the same accessor a deployed worker uses", async () => {
    const file = loadDevSecrets(`{
      // The credentials someone pasted after enabling Google login.
      "auth-google-credentials": {
        "currentVersion": "1",
        "versions": { "1": { "clientId": "id.apps.googleusercontent.com", "clientSecret": "shh" } },
      },
    }`);

    const result = await seedDevSecrets({ file, registry, store: store() });
    const secrets = await secretsStore(deployedEnv(), registry);

    expect(result.seeded).toEqual(["auth-google-credentials", "auth-session-secret"]);
    expect(secrets.get("auth-google-credentials")).toEqual({
      clientId: "id.apps.googleusercontent.com",
      clientSecret: "shh",
    });
    expect(secrets.get("auth-session-secret")).toBe(
      DevSecretEnvelope.parse(result.minted["auth-session-secret"]).versions["1"],
    );
  });

  test("re-seeding leaves the row alone — same value, same updatedAt", async () => {
    const first = await seedDevSecrets({ file: {}, registry: sessionOnly, store: store() });
    const row = await updatedAt("auth-session-secret");

    const second = await seedDevSecrets({ file: { ...first.minted }, registry: sessionOnly, store: store() });

    expect(second.seeded).toEqual([]);
    expect(second.unchanged).toEqual(["auth-session-secret"]);
    expect(await updatedAt("auth-session-secret")).toBe(row);
  });

  test("a multi-version envelope round-trips every version, so rotate --env dev has something to rotate", async () => {
    const file = loadDevSecrets(
      `{ "auth-session-secret": { "currentVersion": "2", "versions": { "1": "old", "2": "new" } } }`,
    );

    await seedDevSecrets({ file, registry: sessionOnly, store: store() });
    const secrets = await secretsStore(deployedEnv(), sessionOnly);

    expect(secrets.getVersions("auth-session-secret")).toEqual({
      currentVersion: "2",
      versions: { "1": "old", "2": "new" },
    });
  });
});

const sessionOnly = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
});

/** The row's `updated_at`, straight from SQLite — the churn a convergent-but-not-idempotent seeder causes. */
async function updatedAt(name: string): Promise<number | undefined> {
  const row = await env.SECRETS.prepare("select updated_at as u from pithy_secrets_system_secrets where name = ?")
    .bind(name)
    .first<{ u: number }>();
  return row?.u;
}
