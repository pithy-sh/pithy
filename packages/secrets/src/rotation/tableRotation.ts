// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { type Kysely, sql } from "kysely";
import { decryptValue, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { SecretTableRegistration } from "../data/secretTables";
import type { SecretsTables } from "../data/tables";
import {
  isSecretTableKeyName,
  isSecretTableName,
  secretTableContext,
  secretTableIdentifier,
  snakeCase,
} from "../tables/defineSecretTable";
import type { AnyTableRow } from "../tables/tableStore";

/**
 * The at-rest rotation's reach into declared tables (`../tables/defineSecretTable`).
 *
 * The manager that runs the rotation is prebuilt and never sees `pithy.config.ts`, so it cannot import a
 * declaration. It does not need to: every declared table's migration registers it in `pithy_secrets_tables`,
 * with its key columns, and this reads that registry at the start of every pass. A table registered after
 * the manager was deployed is therefore swept by the next pass, with no re-provision.
 *
 * **What the rotation reads of a row, and why it reads more than the system table's.** A declared row's
 * ciphertext is bound to its owner (`secretTableContext`), so re-encrypting it means rebuilding that context
 * from the row's key columns. They are read, never written: re-encryption changes the key and nothing else.
 *
 * **A registration is data, and it is held to the declaration's rules before it names an identifier.** The
 * table name and key columns reach SQL as identifiers, so one that is not a legal declared name — a
 * hand-edited row, a corrupt one — is skipped rather than interpolated.
 */

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** One registered table, as the rotation addresses it. */
export interface RegisteredSecretTable {
  /** The declared name — `customer`. */
  name: string;
  /** The camelCase identifier `CamelCasePlugin` snake-cases. */
  identifier: string;
  /** The owner key columns, camelCase. */
  keys: string[];
}

/** The same Kysely, able to address a declared table by name — the base row; key columns through `sql.ref`. */
function anyTable(db: SecretsDb) {
  return db.withTables<Record<string, DatabaseSchema<{ row: typeof AnyTableRow }>["row"]>>();
}

/** Whether a table is present in this database. */
async function tableExists(db: SecretsDb, sqlName: string): Promise<boolean> {
  const found = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table' and name = ${sqlName}`.execute(db);
  return found.rows.length > 0;
}

/**
 * Every declared table this store registers, each held to the declaration's naming rules, and each present.
 * Empty when the registry itself is not there yet — a store `secrets_0002_tables` has not reached rotates
 * exactly as it did before declared tables existed.
 */
export async function registeredSecretTables(db: SecretsDb): Promise<RegisteredSecretTable[]> {
  if (!(await tableExists(db, "pithy_secrets_tables"))) return [];
  const rows = await db
    .selectFrom("pithySecretsTables")
    .select(["name", "keys", "secrets", "createdAt", "updatedAt"])
    .execute();
  const tables: RegisteredSecretTable[] = [];
  for (const row of rows) {
    const parsed = SecretTableRegistration.safeParse(row);
    if (!parsed.success) continue;
    const { name, keys } = parsed.data;
    if (!isSecretTableName(name) || keys.length === 0 || !keys.every(isSecretTableKeyName)) continue;
    const identifier = secretTableIdentifier(name);
    if (!(await tableExists(db, snakeCase(identifier)))) continue;
    tables.push({ name, identifier, keys });
  }
  return tables;
}

/**
 * Re-encrypt up to `limit` rows of one declared table that are not on the current key — the system table's
 * `reencryptBatch`, with the row's owner rebuilt into its bound context. A failure is counted and never
 * described, for the reason `reencryptBatch` gives (#386).
 */
export async function reencryptTableBatch(
  db: SecretsDb,
  config: EncryptionConfig,
  table: RegisteredSecretTable,
  limit: number,
): Promise<{ rotated: number; failed: number }> {
  const result = { rotated: 0, failed: 0 };
  if (limit <= 0) return result;
  const any = anyTable(db);
  const rows = await any
    .selectFrom(table.identifier)
    .select(["id", "name", "encryptedValue", "iv", "keyVersion", ...table.keys.map((key) => any.dynamic.ref(key))])
    .where("keyVersion", "!=", Number(config.currentVersion))
    .limit(limit)
    .execute();

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    try {
      const owner = Object.fromEntries(table.keys.map((key) => [key, String(record[key] ?? "")]));
      // Same context in and out: re-encryption changes the key, never what the ciphertext is bound to.
      const context = secretTableContext(table.name, owner, row.name);
      const reencrypted = await encryptValue(config, context, await decryptValue(config, context, row));
      await any
        .updateTable(table.identifier)
        .set({
          encryptedValue: reencrypted.encryptedValue,
          iv: reencrypted.iv,
          keyVersion: reencrypted.keyVersion,
          updatedAt: SQLiteDate.encode(new Date()),
        })
        .where("id", "=", row.id)
        .execute();
      result.rotated++;
    } catch {
      // No binding (#386): what a decrypt or an encrypt throws names the context, and the context holds the owner.
      result.failed++;
    }
  }
  return result;
}

/** Rows across every registered table sealed under any of `versions` — the declared half of the prune gate. */
export async function countTableRowsOnKeyVersions(db: SecretsDb, versions: readonly number[]): Promise<number> {
  if (versions.length === 0) return 0;
  const any = anyTable(db);
  let total = 0;
  for (const table of await registeredSecretTables(db)) {
    const row = await any
      .selectFrom(table.identifier)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("keyVersion", "in", [...versions])
      .executeTakeFirstOrThrow();
    total += Number(row.count);
  }
  return total;
}
