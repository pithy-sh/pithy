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
import { countOnKeyVersions, promoteStagedKey, reencryptBatch, stageNextKey } from "./keyRotation";

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
    expect(await countOnKeyVersions(db(), ["1"])).toBe(2);

    const result = await reencryptBatch(db(), v2);

    expect(result).toMatchObject({ rotated: 2, failed: 0 });
    expect(await countOnKeyVersions(db(), ["1"])).toBe(0);
    expect(await countOnKeyVersions(db(), ["2"])).toBe(2);
    // The row is now keyVersion 2; it decrypts under the new key, value unchanged.
    expect(await new SystemSecretsStore(db(), v2).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
  });

  test("countOnKeyVersions is zero for an empty store, and reencryptBatch is a no-op", async () => {
    expect(await countOnKeyVersions(db(), ["1", "2"])).toBe(0);
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

describe("the staged envelope is a silent no-op, which is why the pass is never handed one", () => {
  /**
   * **The trap, at the site that springs it (`#647`).**
   *
   * `reencryptBatch` selects rows whose `keyVersion` is not `currentVersion`. The staged envelope still
   * points at N, and every row is already on N — so the select is empty, the batch returns two zeroes, and
   * the pass reads exactly like a store that was already rotated. Every row then stays on the old key while
   * the ledger says the rotation succeeded.
   *
   * This is what a pass-level assertion of "rows ended up on `currentVersion`" cannot see: under the defect
   * the rows *are* on the staged envelope's `currentVersion`, because they never left it. So the property
   * is asserted here, over the two envelopes side by side, where the difference is a count and not a label.
   */
  test("the staged envelope re-encrypts nothing and the promoted envelope re-encrypts the row", async () => {
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));
    const staged = await stageNextKey(v1, new Date("2026-02-01T00:00:00.000Z"));

    // Handed the staged envelope: nothing selected, nothing rolled, nothing said.
    expect(await reencryptBatch(db(), staged.staged)).toEqual({ rotated: 0, failed: 0 });
    expect(await countOnKeyVersions(db(), ["1"])).toBe(1);
    expect(await countOnKeyVersions(db(), [staged.nextVersion])).toBe(0);

    // Handed the promoted envelope: the same row, the same key set, one row rolled.
    const promoted = promoteStagedKey(staged);
    expect(await reencryptBatch(db(), promoted)).toEqual({ rotated: 1, failed: 0 });
    expect(await countOnKeyVersions(db(), ["1"])).toBe(0);
    expect(await countOnKeyVersions(db(), [staged.nextVersion])).toBe(1);
    expect(await new SystemSecretsStore(db(), promoted).getValue("a")).toEqual({
      currentVersion: "1",
      versions: { "1": "va" },
    });
  });
});

describe("countOnKeyVersions", () => {
  test("counts the versions it was handed, not every version that is not current", async () => {
    // The gate asks about the versions **about to be deleted**. Those were the same question while a prune
    // dropped everything but the pointer; they stopped being the same question when the prune began
    // deferring a generation, and a row on the previous key is now perfectly healthy.
    await new SystemSecretsStore(db(), v1).put("old", initialVersionedValue("vold"));
    await new SystemSecretsStore(db(), v2).put("new", initialVersionedValue("vnew"));

    expect(await countOnKeyVersions(db(), ["1"])).toBe(1);
    expect(await countOnKeyVersions(db(), ["2"])).toBe(1);
    expect(await countOnKeyVersions(db(), ["1", "2"])).toBe(2);
    expect(await countOnKeyVersions(db(), ["3"])).toBe(0);
  });

  test("an empty version list counts nothing, over a store that is not empty", async () => {
    // The empty retirement set is the ordinary case for the pass that rotated, so this runs every month —
    // and "no versions" must mean none rather than all. The store holds a row, so an implementation that
    // fell back to a total, or inverted the predicate, answers 1 here.
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));

    expect(await countOnKeyVersions(db(), [])).toBe(0);
  });

  test("a version that is not an integer is refused rather than counted as none", async () => {
    // `Number("two")` is `NaN`, and a `NaN` in this list silently under-counts — which passes the prune
    // gate and deletes a key rows are still sealed under. There is no safe answer, so it is refused.
    await new SystemSecretsStore(db(), v1).put("a", initialVersionedValue("va"));

    await expect(countOnKeyVersions(db(), ["1", "two"])).rejects.toThrowError(/version/);
  });
});
