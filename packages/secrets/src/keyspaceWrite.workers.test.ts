// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { EncryptionConfig } from "./crypto/envelope";
import { secretsTables } from "./data/tables";
import type { SecretsStoreEnv } from "./env/bindings";
import { SecretAlreadyExistsError, SecretCryptoError, SecretNotFoundError } from "./error/errors";
import type { ConfigWriter } from "./manager/configWriter";
import { secrets_0001_init } from "./migrations/0001_init";
import { defineSecretRegistry } from "./registry";
import { runAtRestKeyRotation, type StepRunner } from "./rotation/atRestKeyRotation";
import { secretsStore } from "./secretsStore";
import { RotationTracker } from "./store/rotationTracker";

/**
 * The request-path keyspace write, against a real D1 and the real envelope — the runtime the feature
 * exists for. A Node test can prove which name was composed and which mode was asked for; only this
 * one can prove the row is sealed, readable, picked up by the at-rest rotation, and gone after a
 * delete.
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

function envFor(master: EncryptionConfig = config): SecretsStoreEnv {
  return {
    SECRETS: env.SECRETS,
    SECRETS_ENCRYPTION_KEYS: JSON.stringify(master),
  } as unknown as SecretsStoreEnv;
}

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
  TENANT_API_KEY: { backend: "d1", scope: "environment", rotatable: false, valueType: "text", keyed: true },
});

/** The accessor an app holds: built from the env, exactly as `sharedSecretsStore` hands one over. */
function accessor(master: EncryptionConfig = config) {
  return secretsStore(envFor(master), registry);
}

/** One member row, straight from SQL — for the facts the accessor deliberately cannot expose. */
async function row(storedName: string): Promise<{ keyVersion: number; encryptedValue: string } | null> {
  return env.SECRETS.prepare(
    "select key_version as keyVersion, encrypted_value as encryptedValue from " +
      "pithy_secrets_system_secrets where name = ?",
  )
    .bind(storedName)
    .first<{ keyVersion: number; encryptedValue: string }>();
}

async function rotationRows(name: string): Promise<number> {
  const result = await env.SECRETS.prepare("select count(*) as count from pithy_secrets_rotations where name = ?")
    .bind(name)
    .first<{ count: number }>();
  return Number(result?.count ?? 0);
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("putKeyed — the write a connect flow makes", () => {
  test("a member is sealed and readable in the same request", async () => {
    const secrets = await accessor();

    const result = await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    expect(result).toEqual({ currentVersion: "1" });
    // The read goes through a fresh accessor, as the next request's would: nothing here is cached.
    expect(await (await accessor()).getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      privateKey: "alpha-private-key",
    });
  });

  test("what lands in the row is ciphertext, not the credential", async () => {
    const secrets = await accessor();

    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "REDACT_ME_KEY" });

    const stored = await row("CONNECTION_SIGNING_KEY/conn_a");
    expect(stored).not.toBeNull();
    expect(stored?.encryptedValue).not.toContain("REDACT_ME_KEY");
    expect(atob(stored?.encryptedValue ?? "")).not.toContain("REDACT_ME_KEY");
  });

  test("each tenant gets its own member, and one key never reaches another's", async () => {
    const secrets = await accessor();

    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_b", { privateKey: "bravo-private-key" });

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-private-key" });
    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).toEqual({ privateKey: "bravo-private-key" });
  });

  test("a second create is refused, and the stored credential is untouched", async () => {
    // The failure the default designs against: a live signing key overwritten by a repeated connect.
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    await expect(
      secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "second-attempt-key" }),
    ).rejects.toBeInstanceOf(SecretAlreadyExistsError);

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "alpha-private-key" });
  });

  test("the refusal names the keyspace and never the tenant", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    const error = await secrets
      .putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "second-attempt-key" })
      .catch((e: unknown) => e);

    const serialized = JSON.stringify((error as SecretAlreadyExistsError).payload);
    expect(serialized).toContain("CONNECTION_SIGNING_KEY");
    expect(serialized).not.toContain("conn_a");
  });

  test("replace discards every prior version, which is what a leaked credential needs", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "leaked-private-key" });
    await secrets.rotateKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "second-private-key" });

    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "clean-private-key" }, { replace: true });

    expect(await secrets.getKeyedVersions("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      currentVersion: "1",
      versions: { "1": { privateKey: "clean-private-key" } },
    });
  });

  test("a rotatable keyspace records when the tenant's credential was established", async () => {
    const secrets = await accessor();

    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    expect(await RotationTracker.fromD1(env.SECRETS).getLatestSuccess("CONNECTION_SIGNING_KEY/conn_a")).toBeInstanceOf(
      Date,
    );
    // A keyspace that is not rotatable has no cadence to measure, so it gets no baseline row.
    await secrets.putKeyed("TENANT_API_KEY", "tenant_a", "tenant-api-key");
    expect(await rotationRows("TENANT_API_KEY/tenant_a")).toBe(0);
  });
});

describe("rotateKeyed — two keys during a tenant's rotation", () => {
  test("the new key is current and the old one is still valid", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "first-private-key" });

    const result = await secrets.rotateKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "second-private-key" });

    expect(result).toEqual({ currentVersion: "2" });
    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({ privateKey: "second-private-key" });
    expect(await secrets.getKeyedVersions("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      currentVersion: "2",
      versions: { "1": { privateKey: "first-private-key" }, "2": { privateKey: "second-private-key" } },
    });
  });

  test("rotating a member nobody created is a not-found, never a silent create", async () => {
    const secrets = await accessor();

    await expect(
      secrets.rotateKeyed("CONNECTION_SIGNING_KEY", "conn_missing", { privateKey: "alpha-private-key" }),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(await row("CONNECTION_SIGNING_KEY/conn_missing")).toBeNull();
  });

  test("a keyspace declared rotatable: false refuses before it touches the store", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("TENANT_API_KEY", "tenant_a", "tenant-api-key");

    // Caught rather than `rejects`: this one refuses before it awaits anything, so the promise is
    // already rejected when it is handed over, and workerd reports that as unhandled.
    const error = await secrets.rotateKeyed("TENANT_API_KEY", "tenant_a", "next-key").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InternalError);
    expect(await secrets.getKeyed("TENANT_API_KEY", "tenant_a")).toBe("tenant-api-key");
  });
});

describe("deleteKeyed — a tenant leaves once", () => {
  test("every version goes, and the rotation history with it, in one call", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "first-private-key" });
    await secrets.rotateKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "second-private-key" });
    expect(await rotationRows("CONNECTION_SIGNING_KEY/conn_a")).toBe(1);

    await secrets.deleteKeyed("CONNECTION_SIGNING_KEY", "conn_a");

    expect(await row("CONNECTION_SIGNING_KEY/conn_a")).toBeNull();
    expect(await rotationRows("CONNECTION_SIGNING_KEY/conn_a")).toBe(0);
    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_a")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  test("the tenant beside it is untouched", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_b", { privateKey: "bravo-private-key" });

    await secrets.deleteKeyed("CONNECTION_SIGNING_KEY", "conn_a");

    expect(await secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).toEqual({ privateKey: "bravo-private-key" });
  });

  test("deleting a member twice is a retry, not an error", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    await secrets.deleteKeyed("CONNECTION_SIGNING_KEY", "conn_a");
    await expect(secrets.deleteKeyed("CONNECTION_SIGNING_KEY", "conn_a")).resolves.toBeUndefined();
  });
});

describe("a member written this way is bound to its own name", () => {
  test("one tenant's ciphertext does not open in another tenant's row", async () => {
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_b", { privateKey: "bravo-private-key" });

    // A row mix-up, or a database-write attacker: conn_a's sealed value, moved onto conn_b's row.
    const alpha = await row("CONNECTION_SIGNING_KEY/conn_a");
    await env.SECRETS.prepare(
      "update pithy_secrets_system_secrets set encrypted_value = (select encrypted_value from " +
        "pithy_secrets_system_secrets where name = ?), iv = (select iv from pithy_secrets_system_secrets " +
        "where name = ?) where name = ?",
    )
      .bind("CONNECTION_SIGNING_KEY/conn_a", "CONNECTION_SIGNING_KEY/conn_a", "CONNECTION_SIGNING_KEY/conn_b")
      .run();
    expect((await row("CONNECTION_SIGNING_KEY/conn_b"))?.encryptedValue).toBe(alpha?.encryptedValue);

    await expect(secrets.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).rejects.toBeInstanceOf(SecretCryptoError);
  });
});

describe("at-rest key rotation picks these rows up", () => {
  /** A synchronous step runner — runs each callback immediately (no durable replay in tests). */
  const syncStep: StepRunner = { do: (_name, fn) => fn() };

  test("members written on the request path are re-encrypted like every other row", async () => {
    // The failure this asserts against is silent: a member the cron never visits stays on a key that
    // pruning removes, and nothing says so until a read fails long afterwards. Members are ordinary
    // rows in the ordinary table, which is the whole reason they are picked up — proven, not assumed.
    const secrets = await accessor();
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });
    await secrets.rotateKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-second-key" });
    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_b", { privateKey: "bravo-private-key" });
    await secrets.putKeyed("TENANT_API_KEY", "tenant_a", "tenant-api-key");

    const writes: string[] = [];
    const configWriter: ConfigWriter = {
      write: async (value) => {
        writes.push(value);
      },
    };
    const result = await runAtRestKeyRotation(
      {
        db: createDatabase(env.SECRETS, secretsTables),
        config,
        configWriter,
        tracker: RotationTracker.fromD1(env.SECRETS),
      },
      syncStep,
      { now: new Date("2026-02-01T00:00:00.000Z") },
    );

    // Three members, three rows re-encrypted, and the old key pruned because none was left behind.
    expect(result).toMatchObject({ rotated: 3, failed: 0, newCurrentVersion: 2, pruned: true });
    expect((await row("CONNECTION_SIGNING_KEY/conn_a"))?.keyVersion).toBe(2);
    expect((await row("CONNECTION_SIGNING_KEY/conn_b"))?.keyVersion).toBe(2);
    expect((await row("TENANT_API_KEY/tenant_a"))?.keyVersion).toBe(2);

    // And they still open — under the pruned config, which no longer holds the key they were sealed
    // with. Every version of the rotated member survives the re-encryption too.
    const pruned = JSON.parse(writes[writes.length - 1] ?? "{}") as EncryptionConfig;
    expect(Object.keys(pruned.versions)).toEqual(["2"]);
    const after = await accessor(pruned);
    expect(await after.getKeyedVersions("CONNECTION_SIGNING_KEY", "conn_a")).toEqual({
      currentVersion: "2",
      versions: { "1": { privateKey: "alpha-private-key" }, "2": { privateKey: "alpha-second-key" } },
    });
    expect(await after.getKeyed("CONNECTION_SIGNING_KEY", "conn_b")).toEqual({ privateKey: "bravo-private-key" });
    expect(await after.getKeyed("TENANT_API_KEY", "tenant_a")).toBe("tenant-api-key");
  });

  test("a member written after a rotation seals under the new key", async () => {
    const rotated: EncryptionConfig = {
      currentVersion: "2",
      versions: { "1": config.versions["1"] ?? "", "2": keyB64() },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    };
    const secrets = await accessor(rotated);

    await secrets.putKeyed("CONNECTION_SIGNING_KEY", "conn_a", { privateKey: "alpha-private-key" });

    expect((await row("CONNECTION_SIGNING_KEY/conn_a"))?.keyVersion).toBe(2);
  });
});
