// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { initialVersionedValue } from "../crypto/versionedValue";
import { secretsTables } from "../data/tables";
import { secrets_0001_init } from "../migrations/0001_init";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { countOnOldKeys, reencryptBatch } from "./keyRotation";

function keyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const k1 = keyB64();
const v1: EncryptionConfig = { currentVersion: "1", versions: { "1": k1 }, lastRotatedAt: "2026-01-01T00:00:00.000Z" };
const v2: EncryptionConfig = {
  currentVersion: "2",
  versions: { "1": k1, "2": keyB64() },
  lastRotatedAt: "2026-02-01T00:00:00.000Z",
};

const db = () => createDatabase(env.SECRETS, secretsTables);

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(db());
});

describe("key re-encryption", () => {
  test("reencryptBatch rolls rows from the old key to the current key; values still decrypt", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    await new SystemSecretsStore(db(), v1).put("b", initialVersionedValue("vb"));
    expect(await countOnOldKeys(db(), v2)).toBe(2);

    const result = await reencryptBatch(db(), v2);

    expect(result).toMatchObject({ rotated: 2, failed: 0 });
    expect(await countOnOldKeys(db(), v2)).toBe(0);
    // The row is now keyVersion 2; it decrypts under the new key, value unchanged.
    expect(await new SystemSecretsStore(db(), v2).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
  });

  test("countOnOldKeys is zero for an empty store, and reencryptBatch is a no-op", async () => {
    expect(await countOnOldKeys(db(), v2)).toBe(0);
    // `toEqual` and not `toMatchObject`: the result is two counts, and a third field describing a failure
    // is what `#386` removed. An `errors` array arriving back fails here.
    expect(await reencryptBatch(db(), v2)).toEqual({ rotated: 0, failed: 0 });
  });

  /**
   * The other half of `#386`, at the site where nothing yet reads the result.
   *
   * `reencryptBatch` was already per-row guarded, correctly. Its catch **bound**, and pushed
   * `cause.message` into `result.errors` — text from decrypting a secret, sitting in a returned object.
   * `runAtRestKeyRotation` reads only `failed`, so it disclosed nothing; it was the rule not being
   * followed where nothing looked, which is how the other site in `#386` came to exist.
   *
   * A row whose `keyVersion` names a key the config does not hold is the ordinary way this fails: a
   * master-key rotation that pruned a version some row still names.
   */
  test("a row that will not decrypt is counted, and never described", async () => {
    await new SystemSecretsStore(db(), v1).put("good", initialVersionedValue("vgood"));
    await new SystemSecretsStore(db(), v1).put("bad", initialVersionedValue("vbad"));
    // Orphan one row's key version. Nothing in `v2.versions` can open it, so the decrypt throws.
    await env.SECRETS.prepare("update pithy_secrets_system_secrets set key_version = 99 where name = 'bad'").run();

    const result = await reencryptBatch(db(), v2);

    // The healthy row rolled. The orphan cost itself and nothing else.
    expect(result).toEqual({ rotated: 1, failed: 1 });
    expect(await new SystemSecretsStore(db(), v2).getValue("good")).toEqual({
      currentVersion: "1",
      versions: { "1": "vgood" },
    });
    // Nothing the failure said came back. There is no field for it, and no field appeared.
    expect(Object.keys(result).sort()).toEqual(["failed", "rotated"]);
    expect(JSON.stringify(result)).not.toContain("99");
  });
});
