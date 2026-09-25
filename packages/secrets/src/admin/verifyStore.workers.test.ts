// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { beforeEach, describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import { initialVersionedValue } from "../crypto/versionedValue";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import { secretsTables } from "../data/tables";
import type { SecretBinding, SecretsStoreEnv } from "../env/bindings";
import { secrets_0001_init } from "../migrations/0001_init";
import { generateKeyB64 } from "../rotation/keyRotation";
import { RotationTracker } from "../store/rotationTracker";
import { SystemSecretsStore } from "../store/systemSecretsStore";
import { verifyStoredSecrets } from "./verifyStore";

/**
 * The verification against a real D1 and real `crypto.subtle`, because the one fact it reports is an
 * AES-GCM decrypt. A mock here would prove that a mock returns what it was told to.
 *
 * Every assertion below is paired with the state that makes it the other answer — a config that holds
 * the row's key beside one that does not, a row that opens beside one that has been tampered — so none
 * of them is satisfiable by a function that always reports failure, or always reports success.
 */

/** A recognizable plaintext, so a leak shows up in a string search rather than only in a field name. */
const PLAINTEXT = "PLAINTEXT-DO-NOT-LEAK";

/** A fresh AES-256 config holding exactly the versions asked for, pointed at `current`. */
async function configOf(versions: number[], current: number | string): Promise<EncryptionConfig> {
  const entries: Record<string, string> = {};
  for (const version of versions) entries[String(version)] = await generateKeyB64();
  return { currentVersion: String(current), versions: entries, lastRotatedAt: "2026-01-01T00:00:00.000Z" };
}

/** The same key set with one version's key carried over, so rows sealed under it still open. */
function withVersions(base: EncryptionConfig, keep: number[], current: number): EncryptionConfig {
  const versions: Record<string, string> = {};
  for (const version of keep) {
    const key = base.versions[String(version)];
    if (key !== undefined) versions[String(version)] = key;
  }
  return { ...base, currentVersion: String(current), versions };
}

/** The worker env a verification runs against: this suite's D1, and the master key it is handed. */
function envWith(keys: string | SecretBinding): SecretsStoreEnv {
  return { SECRETS: env.SECRETS, SECRETS_ENCRYPTION_KEYS: keys };
}

/** Seal `count` rows under `config`, named predictably. */
async function seed(config: EncryptionConfig, count: number, prefix = "secret"): Promise<void> {
  const store = new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), config);
  for (let index = 0; index < count; index += 1) {
    await store.put(`${prefix}-${String(index).padStart(4, "0")}`, initialVersionedValue(PLAINTEXT));
  }
}

beforeEach(async () => {
  await env.SECRETS.prepare("drop table if exists pithy_secrets_system_secrets").run();
  await env.SECRETS.prepare("drop table if exists pithy_secrets_rotations").run();
  await secrets_0001_init.up(createDatabase(env.SECRETS, secretsTables));
});

describe("verifyStoredSecrets — the key set resolved", () => {
  test("every row opens under the key it was sealed with", async () => {
    const config = await configOf([1], 1);
    await seed(config, 3);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(report).toEqual({
      keySet: "resolved",
      rows: 3,
      readable: 3,
      unreadable: 0,
      keyVersions: [{ keyVersion: 1, rows: 3 }],
      heldVersions: [1],
      currentVersion: 1,
      currentVersionHeld: true,
      missingVersions: [],
      rotationInProgress: false,
    });
  });

  test("the same rows against a key set that no longer holds their version are unreadable, and the version is named", async () => {
    // The mirror of the case above, and the pair is the point: a detector that always reported failure
    // would fail the first, and one that always reported success fails this. Neither passes both.
    const sealed = await configOf([1], 1);
    await seed(sealed, 3);
    const rotatedPast = await configOf([2], 2);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(rotatedPast)));

    expect(report).toMatchObject({
      keySet: "resolved",
      rows: 3,
      readable: 0,
      unreadable: 3,
      missingVersions: [1],
      heldVersions: [2],
    });
  });

  test("a tampered ciphertext is unreadable while its version is still held — the two faults stay apart", async () => {
    // Their remedies are opposite: restore a key version, versus re-seal a row. Folding them into one
    // count would tell an operator to hand-edit the master key over a single corrupt row.
    const config = await configOf([1], 1);
    await seed(config, 2);
    const db = createDatabase(env.SECRETS, secretsTables);
    await db
      .updateTable("pithySecretsSystemSecrets")
      .set({ encryptedValue: btoa("tampered-ciphertext-bytes") })
      .where("name", "=", "secret-0000")
      .execute();

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(report).toMatchObject({ rows: 2, readable: 1, unreadable: 1, missingVersions: [], heldVersions: [1] });
  });

  test("a pointer the key set does not hold is reported, though every stored row still opens (D9)", async () => {
    // The state step 4 of the rotation exists to prevent: `currentVersion` moved, the key never landed.
    // Every existing row opens, so every count here is the clean one — and every future write fails.
    const sealed = await configOf([1, 2], 1);
    await seed(sealed, 2);
    const pointerMoved = withVersions(sealed, [1], 2);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(pointerMoved)));

    expect(report).toMatchObject({
      readable: 2,
      unreadable: 0,
      missingVersions: [],
      currentVersion: 2,
      currentVersionHeld: false,
    });
  });

  test("a pointer the key set does hold reports held — so the flag above is not simply always false", async () => {
    const config = await configOf([1, 2], 2);
    await seed(config, 1);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(report).toMatchObject({ currentVersion: 2, currentVersionHeld: true, heldVersions: [1, 2] });
  });

  test("a pointer that is not a stringified integer reports null rather than losing the whole read", async () => {
    const config = await configOf([1], 1);
    await seed(config, 2);

    const report = await verifyStoredSecrets(envWith(JSON.stringify({ ...config, currentVersion: "latest" })));

    expect(report).toMatchObject({ keySet: "resolved", rows: 2, readable: 2, currentVersion: null });
  });

  test("an empty pointer reports null rather than version zero", async () => {
    // `Number("")` is `0`, an ordinary version number. A parse that used it would report a store
    // pointed at a key nobody has as one pointed at version 0.
    const config = await configOf([1], 1);
    await seed(config, 1);

    const report = await verifyStoredSecrets(envWith(JSON.stringify({ ...config, currentVersion: "" })));

    expect(report).toMatchObject({ currentVersion: null, currentVersionHeld: false });
  });

  test("the cursor crosses page boundaries without skipping or repeating a row", async () => {
    const config = await configOf([1], 1);
    await seed(config, 250);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)), { batchSize: 100 });

    expect(report).toMatchObject({ rows: 250, readable: 250, keyVersions: [{ keyVersion: 1, rows: 250 }] });
  });

  test("an unprovisioned store reads as empty rather than as broken", async () => {
    const config = await configOf([1], 1);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(report).toMatchObject({ rows: 0, readable: 0, unreadable: 0, keyVersions: [], missingVersions: [] });
  });

  test("a second read of the binding clears a missing version a propagation race invented", async () => {
    // The at-rest rotation writes rows under N+1 and the key reaches the binding a moment later. A sweep
    // holding the older snapshot sees rows on a version its config does not hold — and the remedy the
    // CLI prints for a real one is to hand-edit the master key. So it is confirmed against a fresh read.
    const full = await configOf([1, 2], 2);
    await seed(full, 2);
    const stale = withVersions(full, [1], 1);
    const reads = [JSON.stringify(stale), JSON.stringify(full)];
    let call = 0;
    const binding: SecretBinding = {
      get: async () => reads[Math.min(call++, reads.length - 1)] ?? "",
    };

    const report = await verifyStoredSecrets(envWith(binding));

    expect(call).toBe(2);
    expect(report).toMatchObject({ missingVersions: [], heldVersions: [1, 2] });
  });

  test("a version that is genuinely gone survives the second read", async () => {
    // The other half, and the reason the re-read is not simply a way to never report anything: the
    // binding answers the same both times, so the finding stands.
    const sealed = await configOf([1, 2], 2);
    await seed(sealed, 2);
    const pruned = withVersions(sealed, [1], 1);

    const report = await verifyStoredSecrets(envWith(JSON.stringify(pruned)));

    expect(report).toMatchObject({ missingVersions: [2], unreadable: 2 });
  });

  test("a live at-rest rotation is reported, so a missing version is not read as a fault", async () => {
    const config = await configOf([1], 1);
    await seed(config, 1);
    await RotationTracker.fromD1(env.SECRETS).startRotation(AT_REST_ROTATION_NAME, "cron", "test");

    const report = await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(report.rotationInProgress).toBe(true);
  });
});

describe("verifyStoredSecrets — the master key that will not resolve (D15)", () => {
  test("a binding that is not JSON is its own answer, not a throw", async () => {
    const config = await configOf([1], 1);
    await seed(config, 3);

    const report = await verifyStoredSecrets(envWith("not-json-at-all"));

    expect(report).toEqual({
      keySet: "unreadable",
      rows: 3,
      keyVersions: [{ keyVersion: 1, rows: 3 }],
      rotationInProgress: false,
    });
  });

  test("a binding holding JSON that is not an EncryptionConfig answers the same way", async () => {
    const config = await configOf([1], 1);
    await seed(config, 1);

    const report = await verifyStoredSecrets(envWith(JSON.stringify({ currentVersion: 1 })));

    expect(report.keySet).toBe("unreadable");
  });

  test("nothing is opened, so nothing claims to have been", async () => {
    // The shape is the guard: an `unreadable` key set has no `readable` field at all, so a caller cannot
    // read "0 of 3 opened" off a store that was never opened. Narrowing is what makes it unavailable.
    const config = await configOf([1], 1);
    await seed(config, 3);

    const report = await verifyStoredSecrets(envWith("not-json-at-all"));

    expect(report.keySet === "unreadable" && "readable" in report).toBe(false);
  });
});

describe("verifyStoredSecrets — what leaves the Worker", () => {
  test("no stored name reaches the report, keyspace members included", async () => {
    // A keyspace member's stored name is `<entry>/<key>` — a tenant identifier. The report carries no
    // name at all, so this is a property of the shape rather than of this one name.
    const config = await configOf([1], 1);
    await seed(config, 1, "payments/tenant-a");

    const serialized = JSON.stringify(await verifyStoredSecrets(envWith(JSON.stringify(config))));

    expect(serialized).not.toContain("payments");
    expect(serialized).not.toContain("tenant-a");
  });

  test("no plaintext and no key material reach the report", async () => {
    const config = await configOf([1], 1);
    await seed(config, 2);
    const key = config.versions["1"] ?? "";

    const serialized = JSON.stringify(await verifyStoredSecrets(envWith(JSON.stringify(config))));

    expect(key.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain(key);
  });

  test("an unreadable row contributes a count and nothing the decrypt said", async () => {
    const sealed = await configOf([1], 1);
    await seed(sealed, 1);
    const wrongKey = await configOf([1], 1);

    const serialized = JSON.stringify(await verifyStoredSecrets(envWith(JSON.stringify(wrongKey))));

    // The words the envelope's own failure uses. None of them is in scope here to forward: the sweep
    // takes a boolean over a `catch` that binds nothing.
    expect(serialized).not.toContain("AES-GCM");
    expect(serialized).not.toContain("tampered");
    expect(serialized).not.toContain("secret-0000");
  });

  test("verifyStoredSecrets writes nothing", async () => {
    const config = await configOf([1], 1);
    await seed(config, 2);
    const db = createDatabase(env.SECRETS, secretsTables);
    const before = await db.selectFrom("pithySecretsSystemSecrets").select(["name", "updatedAt"]).execute();
    const rotationsBefore = await db.selectFrom("pithySecretsRotations").select("id").execute();

    await verifyStoredSecrets(envWith(JSON.stringify(config)));

    expect(await db.selectFrom("pithySecretsSystemSecrets").select(["name", "updatedAt"]).execute()).toEqual(before);
    expect(await db.selectFrom("pithySecretsRotations").select("id").execute()).toEqual(rotationsBefore);
  });
});
