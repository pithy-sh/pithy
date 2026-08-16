// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test, vi } from "vitest";
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

// A deployed env: `ENVIRONMENT` is a managed env. Since #153 it changes nothing about resolution —
// {@link devEnvWith} is the same env without it, and the two answer identically.
function envWith(extra: Record<string, unknown> = {}): SecretsStoreEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: JSON.stringify(config),
    ENVIRONMENT: "prod",
    ...extra,
  } as unknown as SecretsStoreEnv;
}

/** Local dev: no `ENVIRONMENT`, the same `SECRETS` D1 and master key `pithy dev` binds. */
function devEnvWith(extra: Record<string, unknown> = {}): SecretsStoreEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: JSON.stringify(config),
    ...extra,
  } as unknown as SecretsStoreEnv;
}

/** The error a synchronous read threw, for assertions about its payload. Fails if it threw nothing. */
function throwsFrom(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to throw");
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

  test("a declared d1 secret that was never written fails loudly when it is read", async () => {
    const registry = defineSecretRegistry({
      missing: { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), registry);

    expect(() => secrets.get("missing")).toThrow(SecretNotFoundError);
  });

  test("an unwritten secret costs the secret beside it nothing (#170)", async () => {
    // The defect: one unset secret in the combined registry took every capability's read down with it.
    await store().put("auth-session-secret", initialVersionedValue("seeded-session-key"));
    const registry = defineSecretRegistry({
      "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
      "auth-google-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), registry);

    expect(secrets.get("auth-session-secret")).toBe("seeded-session-key");
    const error = throwsFrom(() => secrets.get("auth-google-credentials"));
    expect(error).toBeInstanceOf(SecretNotFoundError);
    const serialized = JSON.stringify((error as SecretNotFoundError).payload);
    expect(serialized).toContain("auth-google-credentials");
    expect(serialized).not.toContain("auth-session-secret");
  });
});

describe("secretsStore — dev reads the seeded row, not a binding (#153)", () => {
  const registry = defineSecretRegistry({
    "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  });

  test("a d1 secret resolves from its row with no ENVIRONMENT at all", async () => {
    await store().put("auth-session-secret", initialVersionedValue("seeded-session-key"));

    const secrets = await secretsStore(devEnvWith(), registry);

    expect(secrets.get("auth-session-secret")).toBe("seeded-session-key");
  });

  test("every version survives, where the old dev path collapsed a rotated secret to one", async () => {
    await store().put("auth-session-secret", appendVersion(initialVersionedValue("old"), "new"));

    const secrets = await secretsStore(devEnvWith(), registry);

    expect(secrets.getVersions("auth-session-secret")).toEqual({
      currentVersion: "2",
      versions: { "1": "old", "2": "new" },
    });
  });

  test("a same-named binding does not shadow the row in dev either", async () => {
    await store().put("auth-session-secret", initialVersionedValue("from-the-row"));

    const secrets = await secretsStore(devEnvWith({ "auth-session-secret": "from-dev-vars" }), registry);

    expect(secrets.get("auth-session-secret")).toBe("from-the-row");
  });

  test("no row but a binding of the same name names the secret and the fix", async () => {
    // The one shape an upgrade produces: a pre-#149 `.dev.vars` line, or a Workers-runtime test injecting
    // a `d1` value as a bare string. "not provisioned" would be a poor answer about a value sitting there.
    const secrets = await secretsStore(devEnvWith({ "auth-session-secret": "REDACT_ME" }), registry);
    const error = throwsFrom(() => secrets.get("auth-session-secret"));

    expect(error).toBeInstanceOf(ValidationError);
    const payload = (error as ValidationError).payload;
    expect(payload.message).toContain("auth-session-secret");
    expect(payload.action).toContain("pithy seed");
    expect(JSON.stringify(payload)).not.toContain("REDACT_ME");
  });

  test("a cf-secrets-store entry still takes a plain string in dev — permanently", async () => {
    // `pithy token mint` writes a raw token, and so does `wrangler secrets-store secret create`. There is
    // no envelope to find there and never will be.
    const cf = defineSecretRegistry({
      CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });

    const secrets = await secretsStore(devEnvWith({ CLOUDFLARE_API_TOKEN: "bare-dev-token" }), cf);

    expect(secrets.get("CLOUDFLARE_API_TOKEN")).toBe("bare-dev-token");
  });
});

describe("secretsStore — a keyed entry over the real encrypted store", () => {
  const ConnectionKey = z
    .object({ privateKey: z.string().min(8).describe("PKCS#8 private key.") })
    .describe("A customer connection's signing key.");

  const registry = defineSecretRegistry({
    CONNECTION_SIGNING_KEY: {
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "json",
      schema: ConnectionKey,
      keyed: true,
    },
    "auth-signing-key": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
  });

  /** Write one keyspace member the way an app does — through the accessor, on the request path. */
  async function putMember(key: string, privateKey: string): Promise<void> {
    await (await secretsStore(envWith(), registry)).putKeyed("CONNECTION_SIGNING_KEY", key, { privateKey });
  }

  test("a member is written and read back through the same encrypted store", async () => {
    await store().put("auth-signing-key", initialVersionedValue("kid-1-key"));
    await putMember("conn_a", "alpha-private-key");

    const secrets = await secretsStore(envWith(), registry);

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-private-key" });
    expect(secrets.get("auth-signing-key")).toBe("kid-1-key");
  });

  test("each tenant reads its own member and no other", async () => {
    await store().put("auth-signing-key", initialVersionedValue("kid-1-key"));
    await putMember("conn_a", "alpha-private-key");
    await putMember("conn_b", "bravo-private-key");

    const secrets = await secretsStore(envWith(), registry);

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-private-key" });
    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).toEqual({ privateKey: "bravo-private-key" });
    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_c")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("a value stored under the bare keyspace name is not served to any key", async () => {
    await store().put("auth-signing-key", initialVersionedValue("kid-1-key"));
    // A mis-write, or a name left over from before the entry was keyed. It must not become every
    // tenant's key: a member read resolves `<keyspace>/<key>` or nothing.
    await store().put("CONNECTION_SIGNING_KEY", initialVersionedValue(JSON.stringify({ privateKey: "everyones" })));

    const secrets = await secretsStore(envWith(), registry);

    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("a keyspace does not have to be provisioned for the accessor to build", async () => {
    await store().put("auth-signing-key", initialVersionedValue("kid-1-key"));

    // No member exists at all. The named d1 secret still resolves; the keyspace costs nothing until read.
    const secrets = await secretsStore(envWith(), registry);

    expect(secrets.get("auth-signing-key")).toBe("kid-1-key");
  });
});

/**
 * **#170's promise, for the row that is there and will not open (#384).**
 *
 * "A failure belongs to its secret" held for a *missing* row and not for an *unreadable* one, because the
 * batch decrypt threw and this accessor held that one throw against every `d1` name it had asked for. The
 * blast radius was the registry.
 *
 * That is also why `#381`'s own title case was only half covered. `#381` split the provider credentials off
 * the sign-in precondition in `buildAuthInstance`, so a provider that will not resolve no longer takes
 * email/password and magic link down — but an *unreadable* `auth-github-credentials` still did, one layer
 * lower, because `auth-session-secret` was in the same batch and died with it. The plant below is that exact
 * pair, in the storage it actually happens in.
 *
 * The plants are raw SQL. The store cannot write a row it cannot read, so a gate built from its writer could
 * not fail — and would be derived from the reader it polices.
 */
describe("secretsStore — an unreadable row costs its own name and no other (#384)", () => {
  /** Corrupt one row's ciphertext in place: same length, same alphabet, one byte no key authenticates. */
  async function corrupt(name: string): Promise<void> {
    const row = await env.SECRETS.prepare("select encrypted_value from pithy_secrets_system_secrets where name = ?")
      .bind(name)
      .first<{ encrypted_value: string }>();
    if (!row) throw new Error(`no row stored for '${name}'`);
    const head = row.encrypted_value.startsWith("A") ? "B" : "A";
    await env.SECRETS.prepare("update pithy_secrets_system_secrets set encrypted_value = ? where name = ?")
      .bind(`${head}${row.encrypted_value.slice(1)}`, name)
      .run();
  }

  /** Orphan a row's key version — the master-key rotation that pruned a version some row still names. */
  async function orphan(name: string): Promise<void> {
    await env.SECRETS.prepare("update pithy_secrets_system_secrets set key_version = 99 where name = ?")
      .bind(name)
      .run();
  }

  const authRegistry = defineSecretRegistry({
    "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    "auth-github-credentials": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
  });

  test("the sign-in precondition still reads when the OAuth credential will not open (#381's title case)", async () => {
    await store().put("auth-session-secret", initialVersionedValue("seeded-session-key"));
    await store().put("auth-github-credentials", initialVersionedValue("the-github-secret"));
    await corrupt("auth-github-credentials");

    const secrets = await secretsStore(envWith(), authRegistry);

    expect(secrets.get("auth-session-secret")).toBe("seeded-session-key");
    const error = throwsFrom(() => secrets.get("auth-github-credentials"));
    expect(error).toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ code: "secrets/crypto_failed" }) }),
    );
    const serialized = JSON.stringify((error as { payload: unknown }).payload);
    expect(serialized).toContain("auth-github-credentials");
    expect(serialized).not.toContain("auth-session-secret");
  });

  test("a key version the master key no longer holds costs the same one name", async () => {
    await store().put("auth-session-secret", initialVersionedValue("seeded-session-key"));
    await store().put("auth-github-credentials", initialVersionedValue("the-github-secret"));
    await orphan("auth-github-credentials");

    const secrets = await secretsStore(envWith(), authRegistry);

    expect(secrets.get("auth-session-secret")).toBe("seeded-session-key");
    expect(throwsFrom(() => secrets.get("auth-github-credentials"))).toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ code: "secrets/crypto_failed" }) }),
    );
  });

  /**
   * **Two faults, two remedies, two codes.** Provision the missing one; investigate or re-seal the unreadable
   * one. Asserted on the errors the reads raise, not on anything that renders them.
   */
  test("a missing secret and an unreadable one are told apart at the read", async () => {
    await store().put("stored-but-broken", initialVersionedValue("v"));
    await corrupt("stored-but-broken");
    const registry = defineSecretRegistry({
      "stored-but-broken": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
      "never-written": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), registry);

    const unreadable = throwsFrom(() => secrets.get("stored-but-broken")) as { payload: { code: string } };
    const missing = throwsFrom(() => secrets.get("never-written")) as { payload: { code: string } };
    expect(unreadable.payload.code).toBe("secrets/crypto_failed");
    expect(missing.payload.code).toBe("secrets/not_found");
    expect(missing).toBeInstanceOf(SecretNotFoundError);
  });

  test("a subset carries the unreadable secret's failure and no neighbour's", async () => {
    await store().put("auth-session-secret", initialVersionedValue("seeded-session-key"));
    await store().put("auth-github-credentials", initialVersionedValue("the-github-secret"));
    await corrupt("auth-github-credentials");
    const sessionOnly = defineSecretRegistry({
      "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    });

    const secrets = await secretsStore(envWith(), authRegistry);

    // The slice a capability composes: the neighbour's unreadable row is not in it, and cannot trip it.
    expect(secrets.subset(sessionOnly).get("auth-session-secret")).toBe("seeded-session-key");
  });

  test("nothing from the decryption failure travels into the held error or a console", async () => {
    await store().put("auth-github-credentials", initialVersionedValue("the-github-secret"));
    const row = await env.SECRETS.prepare("select encrypted_value, iv from pithy_secrets_system_secrets where name = ?")
      .bind("auth-github-credentials")
      .first<{ encrypted_value: string; iv: string }>();
    await corrupt("auth-github-credentials");

    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((channel) =>
      vi.spyOn(console, channel).mockImplementation(() => {}),
    );

    const secrets = await secretsStore(envWith(), authRegistry);
    const error = throwsFrom(() => secrets.get("auth-github-credentials")) as Error & { payload?: unknown };

    const said = [
      error.message,
      error.stack ?? "",
      JSON.stringify(error.payload),
      ...spies.flatMap((spy) => spy.mock.calls.flat().map(String)),
    ].join("\n");

    for (const forbidden of [row?.encrypted_value ?? "", row?.iv ?? "", "the-github-secret"]) {
      expect(said).not.toContain(forbidden);
    }
    expect(said).not.toContain("AES-GCM decrypt failed");
    expect(said).not.toContain("tampered ciphertext");
    expect(said).not.toContain("not present in SECRETS_ENCRYPTION_KEYS");
    expect(said).not.toContain("decrypted secret plaintext");
    // The `catch` bound nothing, so there was nothing to attach.
    expect(error.cause).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
