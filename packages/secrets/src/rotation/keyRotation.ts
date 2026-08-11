// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { decryptValue, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import type { SecretsTables } from "../data/tables";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** Generate a fresh AES-256 key, base64-encoded. The encryption-key version axis (not value version). */
export async function generateKeyB64(): Promise<string> {
  // generateKey is typed `CryptoKey | CryptoKeyPair` and exportKey("raw") `ArrayBuffer | JsonWebKey`;
  // for a symmetric AES-GCM key the runtime returns the CryptoKey / ArrayBuffer branch.
  const key = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const exported = new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
  let binary = "";
  for (const byte of exported) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Add a fresh key as the next version and make it current, keeping every prior key so rows not yet
 * re-encrypted stay decryptable through the overlap window.
 */
export async function mergeNextKey(config: EncryptionConfig, now: Date = new Date()): Promise<EncryptionConfig> {
  const nextVersion = String(Number(config.currentVersion) + 1);
  return {
    currentVersion: nextVersion,
    versions: { ...config.versions, [nextVersion]: await generateKeyB64() },
    lastRotatedAt: now.toISOString(),
  };
}

/**
 * Drop every key except the current version. Returns `null` when there is nothing to prune (a
 * single key already). Pruning is only safe once no row references an old version.
 */
export function pruneOldKeys(config: EncryptionConfig): EncryptionConfig | null {
  if (Object.keys(config.versions).length <= 1) return null;
  const currentKey = config.versions[config.currentVersion];
  if (currentKey === undefined) return null;
  return {
    currentVersion: config.currentVersion,
    versions: { [config.currentVersion]: currentKey },
    lastRotatedAt: config.lastRotatedAt,
  };
}

/** One re-encryption batch: rows rolled to the current key, plus any per-row failures. */
export interface ReencryptResult {
  rotated: number;
  failed: number;
  errors: Array<{ id: number; error: string }>;
}

/**
 * Re-encrypt one batch of `pithy_secrets_system_secrets` rows that are not on the current key
 * version: decrypt under the row's old key, re-encrypt under the current key, update in place. The
 * plaintext (the `{ currentVersion, versions }` value envelope) is opaque here — only the
 * encryption key changes. Each row is independent; a failure is accumulated, never thrown, so one
 * bad row cannot abort the batch.
 */
export async function reencryptBatch(
  db: SecretsDb,
  config: EncryptionConfig,
  batchSize = 100,
): Promise<ReencryptResult> {
  const result: ReencryptResult = { rotated: 0, failed: 0, errors: [] };
  const rows = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select(["id", "name", "encryptedValue", "iv", "keyVersion"])
    .where("keyVersion", "!=", Number(config.currentVersion))
    .limit(batchSize)
    .execute();
  if (rows.length === 0) return result;

  for (const row of rows) {
    try {
      // Same name in and out: re-encryption changes the key, never the bound context.
      const plaintext = await decryptValue(config, row.name, row);
      const reencrypted = await encryptValue(config, row.name, plaintext);
      await db
        .updateTable("pithySecretsSystemSecrets")
        .set({
          encryptedValue: reencrypted.encryptedValue,
          iv: reencrypted.iv,
          keyVersion: reencrypted.keyVersion,
          updatedAt: SQLiteDate.encode(new Date()),
        })
        .where("id", "=", row.id)
        .execute();
      result.rotated++;
    } catch (cause) {
      result.failed++;
      result.errors.push({ id: row.id, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return result;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whether an at-rest rotation is due: the configured interval has elapsed since `lastRotatedAt`.
 * The cron fires on a fixed schedule and calls this so it only rotates when due, not every tick.
 */
export function isRotationDue(lastRotatedAt: string, intervalDays: number, now: Date = new Date()): boolean {
  return now.getTime() >= new Date(lastRotatedAt).getTime() + intervalDays * MS_PER_DAY;
}

/** Count rows still on a non-current key version — the signal for when pruning is safe. */
export async function countOnOldKeys(db: SecretsDb, config: EncryptionConfig): Promise<number> {
  const row = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("keyVersion", "!=", Number(config.currentVersion))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
