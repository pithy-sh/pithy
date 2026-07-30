// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { EncryptionConfig } from "./crypto/envelope";
import { appendVersion, encodeVersionedValue, initialVersionedValue } from "./crypto/versionedValue";
import { secretsTables } from "./data/tables";
import type { SecretsStoreEnv } from "./env/bindings";
import { SecretNotFoundError } from "./error/errors";
import { secrets_0001_init } from "./migrations/0001_init";
import { defineSecretRegistry } from "./registry";
import { secretsStore } from "./secretsStore";
import { SystemSecretsStore } from "./store/systemSecretsStore";

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

// A deployed env: `ENVIRONMENT` is a managed env, so the reader routes by backend (d1 → the store).
function envWith(extra: Record<string, unknown> = {}): SecretsStoreEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: JSON.stringify(config),
    ENVIRONMENT: "production",
    ...extra,
  } as unknown as SecretsStoreEnv;
}

function store(): SystemSecretsStore {
  return new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), config);
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("secretsStore — d1 backend", () => {
  test("get resolves to the current value, decrypted", async () => {
    await store().put("auth-signing-key", initialVersionedValue("kid-1-key"));
    const registry = defineSecretRegistry({
      "auth-signing-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), registry);

    expect(secrets.get("auth-signing-key")).toBe("kid-1-key");
  });

  test("getVersions resolves the current pointer and every valid version", async () => {
    await store().put("signing-keys", appendVersion(initialVersionedValue("key-1"), "key-2"));
    const registry = defineSecretRegistry({
      "signing-keys": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), registry);

    expect(secrets.get("signing-keys")).toBe("key-2");
    expect(secrets.getVersions("signing-keys")).toEqual({
      currentVersion: "2",
      versions: { "1": "key-1", "2": "key-2" },
    });
  });

  test("a json d1 secret is parsed and validated", async () => {
    await store().put("emailer", initialVersionedValue(JSON.stringify({ apiKey: "abcdefgh" })), "json");
    const registry = defineSecretRegistry({
      emailer: {
        backend: "d1",
        scope: "environment",
        rotatable: false,
        valueType: "json",
        schema: z.object({ apiKey: z.string().describe("Key.") }).describe("Emailer."),
      },
    });

    const secrets = await secretsStore(envWith(), registry);

    expect(secrets.get("emailer")).toEqual({ apiKey: "abcdefgh" });
  });

  test("resolves d1 and cf-secrets-store entries together in one batch", async () => {
    await store().put("auth-signing-key", initialVersionedValue("from-d1"));
    const registry = defineSecretRegistry({
      "auth-signing-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
      NPM_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });

    const secrets = await secretsStore(envWith({ NPM_TOKEN: "from-binding" }), registry);

    expect(secrets.get("auth-signing-key")).toBe("from-d1");
    expect(secrets.get("NPM_TOKEN")).toBe("from-binding");
  });

  test("a cf-secrets-store value written as the uniform envelope round-trips as a one-entry envelope", async () => {
    const registry = defineSecretRegistry({
      CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });

    const binding = encodeVersionedValue(initialVersionedValue("cf-token-value"));
    const secrets = await secretsStore(envWith({ CLOUDFLARE_API_TOKEN: binding }), registry);

    expect(secrets.get("CLOUDFLARE_API_TOKEN")).toBe("cf-token-value");
    expect(secrets.getVersions("CLOUDFLARE_API_TOKEN")).toEqual({
      currentVersion: "1",
      versions: { "1": "cf-token-value" },
    });
  });

  test("a cf-secrets-store multi-version envelope exposes the current pointer and every version", async () => {
    const registry = defineSecretRegistry({
      SIGNING: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });

    const binding = encodeVersionedValue(appendVersion(initialVersionedValue("v1"), "v2"));
    const secrets = await secretsStore(envWith({ SIGNING: binding }), registry);

    expect(secrets.get("SIGNING")).toBe("v2");
    expect(secrets.getVersions("SIGNING")).toEqual({ currentVersion: "2", versions: { "1": "v1", "2": "v2" } });
  });

  test("a bare cf-secrets-store value (local dev .dev.vars) resolves as a one-entry envelope", async () => {
    const registry = defineSecretRegistry({
      CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });

    const secrets = await secretsStore(envWith({ CLOUDFLARE_API_TOKEN: "bare-dev-token" }), registry);

    expect(secrets.get("CLOUDFLARE_API_TOKEN")).toBe("bare-dev-token");
    expect(secrets.getVersions("CLOUDFLARE_API_TOKEN")).toEqual({
      currentVersion: "1",
      versions: { "1": "bare-dev-token" },
    });
  });

  test("a declared d1 secret that was never written fails loudly", async () => {
    const registry = defineSecretRegistry({
      missing: { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });

    await expect(secretsStore(envWith(), registry)).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});
