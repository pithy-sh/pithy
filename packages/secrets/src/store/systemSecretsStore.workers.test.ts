// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { appendVersion, currentValue, initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { SystemSecretsStore } from "./systemSecretsStore";

function randomKeyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const k1 = randomKeyB64();
const config: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": k1 },
  lastRotatedAt: "2026-01-01T00:00:00.000Z",
};

function newStore(cfg: EncryptionConfig = config): SystemSecretsStore {
  return new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), cfg);
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("SystemSecretsStore", () => {
  test("put then getValue round-trips the value envelope", async () => {
    const store = newStore();
    await store.put("api-token", initialVersionedValue("t0p-s3cret"));

    expect(await store.getValue("api-token")).toEqual({ currentVersion: "1", versions: { "1": "t0p-s3cret" } });
  });

  test("the value is encrypted at rest — the ciphertext is not the plaintext", async () => {
    await newStore().put("api-token", initialVersionedValue("t0p-s3cret"));

    const row = await env.SECRETS.prepare(
      "select encrypted_value, value_type from pithy_secrets_system_secrets where name = ?",
    )
      .bind("api-token")
      .first<{ encrypted_value: string; value_type: string }>();
    expect(row?.encrypted_value).toBeTruthy();
    expect(row?.encrypted_value).not.toContain("t0p-s3cret");
    expect(row?.value_type).toBe("text");
  });

  test("a second put updates in place — one row, new value", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("old"));
    await store.put("k", initialVersionedValue("new"));

    expect(await store.getValue("k")).toEqual({ currentVersion: "1", versions: { "1": "new" } });
    expect(await store.listNames()).toEqual(["k"]);
  });

  test("a multi-version envelope persists every valid version with an explicit current pointer", async () => {
    const store = newStore();
    await store.put("signing-key", appendVersion(initialVersionedValue("kid-1"), "kid-2"));

    const value = await store.getValue("signing-key");
    expect(value).toEqual({ currentVersion: "2", versions: { "1": "kid-1", "2": "kid-2" } });
    expect(value && currentValue(value)).toBe("kid-2");
  });

  test("delete removes the secret; has reflects it", async () => {
    const store = newStore();
    await store.put("k", initialVersionedValue("v"));
    expect(await store.has("k")).toBe(true);

    await store.delete("k");

    expect(await store.has("k")).toBe(false);
    expect(await store.getValue("k")).toBeUndefined();
  });

  test("getValues batch-decrypts only the requested names", async () => {
    const store = newStore();
    await store.put("a", initialVersionedValue("1"));
    await store.put("b", initialVersionedValue("2"));
    await store.put("c", initialVersionedValue("3"));

    expect(await store.getValues(["a", "b"])).toEqual({
      a: { currentVersion: "1", versions: { "1": "1" } },
      b: { currentVersion: "1", versions: { "1": "2" } },
    });
  });

  test("decrypts across an at-rest key-rotation overlap window", async () => {
    await newStore(config).put("k", initialVersionedValue("written-under-v1"));

    // The at-rest job rotates: v2 becomes current, v1 stays available to decrypt old rows.
    const rotated: EncryptionConfig = {
      currentVersion: "2",
      versions: { "1": k1, "2": randomKeyB64() },
      lastRotatedAt: "2026-02-01T00:00:00.000Z",
    };
    expect(await newStore(rotated).getValue("k")).toEqual({
      currentVersion: "1",
      versions: { "1": "written-under-v1" },
    });
  });
});
