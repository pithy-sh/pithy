// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { SecretsTables } from "../data/tables";

/**
 * **What a value rotation's retirement waits for: every value sealed under the secret, moved (#602).**
 *
 * A secret's registry entry names what is encrypted under it at rest and never expires —
 * `overlap.reencrypt`. Those values outlive any overlap, so time alone never makes retiring the old version
 * safe. The Worker that holds them re-encrypts them under the newest version and records it here; the
 * secrets manager reads the record before it retires anything, and retires nothing while a dependent is
 * behind.
 *
 * The record lives in the secrets D1 because it is the one database both Workers bind. It holds a version
 * key per dependent and nothing more, so the manager can ask the question without learning anything about
 * the rows the answer is about.
 */

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** One dependent, moved: the secret it is sealed under, its name, and the version it is now sealed under. */
export interface ReencryptionRecord {
  /** The secret, by registry name. */
  name: string;
  /** The dependent, as the entry's `overlap.reencrypt` names it. */
  dependent: string;
  /** The version key every one of the dependent's values is now sealed under. */
  version: string;
}

/**
 * Record that `dependent` is sealed under `version` of `name`. Upserts: one row per secret and dependent,
 * replaced each time it moves.
 */
export async function recordReencryption(db: SecretsDb, record: ReencryptionRecord): Promise<void> {
  const recordedAt = SQLiteDate.encode(new Date());
  await db
    .insertInto("pithySecretsReencryptions")
    .values({ name: record.name, dependent: record.dependent, version: record.version, recordedAt })
    .onConflict((conflict) =>
      conflict.columns(["name", "dependent"]).doUpdateSet({ version: record.version, recordedAt }),
    )
    .execute();
}

/**
 * The dependents of `name` not yet re-encrypted under `version` — the ones a retirement still waits for.
 *
 * A dependent with no row is pending, and so is one whose recorded version is below `version`. Versions
 * are compared as the integers they spell, so `"10"` is past `"9"`.
 */
export async function pendingReencryptions(
  db: SecretsDb,
  name: string,
  dependents: readonly string[],
  version: string,
): Promise<string[]> {
  if (dependents.length === 0) return [];
  const rows = await db
    .selectFrom("pithySecretsReencryptions")
    .select(["dependent", "version"])
    .where("name", "=", name)
    .where("dependent", "in", [...dependents])
    .execute();
  const recorded = new Map(rows.map((row) => [row.dependent, Number(row.version)]));
  return dependents.filter((dependent) => {
    const at = recorded.get(dependent);
    return at === undefined || !Number.isInteger(at) || at < Number(version);
  });
}
