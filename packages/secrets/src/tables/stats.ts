// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { SecretTableRegistration } from "../data/secretTables";
import type { SecretsTables } from "../data/tables";
import { registeredSecretTables } from "../rotation/tableRotation";
import type { AnyTableRow } from "./tableStore";

/**
 * What an operator may see of a vault's declared tables: each table's keys and secret names, how many rows
 * hold each name, and which master-key version sealed them. **Counts and versions only** — no owner, no
 * value, and nothing a row holds beyond the version that sealed it.
 *
 * The key-version spread is the reason it exists. At-rest rotation re-encrypts row by row, so a pass that
 * stopped partway across a large customer table leaves some rows on the old key; the operator who triggered
 * it should be able to see that, and `pithy secrets tables` and `pithy doctor` read it from here.
 *
 * **The newest version is what the rows say, not what the key set says.** The CLI cannot read the master key —
 * it is a Worker-only binding — so "current" here is the newest version any row in the vault, system table
 * included, is sealed under. A rotation moves every row to its new key, so a row below that is a row a pass
 * did not reach.
 */

/** One declared secret name's rows. */
export const SecretTableSecretStats = z
  .object({
    name: z.string().describe("The secret name."),
    rows: z.number().int().describe("How many owners hold it."),
    keyVersions: z
      .record(z.string(), z.number().int().describe("Rows sealed under that version."))
      .describe(
        "Master-key version → rows sealed under it. More than one entry means a rotation has not reached every row.",
      ),
  })
  .describe("One secret name's rows in a declared table, by key version.");
export type SecretTableSecretStats = z.infer<typeof SecretTableSecretStats>;

/** One registered table's stats. */
export const SecretTableStats = z
  .object({
    table: z.string().describe("The declared table's name."),
    keys: z.array(z.string().describe("An owner key column.")).describe("Its owner key columns."),
    secrets: z.array(SecretTableSecretStats).describe("Each secret name it registers, and any it holds rows for."),
  })
  .describe("One declared table as the vault holds it: keys, secret names, row counts and key versions.");
export type SecretTableStats = z.infer<typeof SecretTableStats>;

/** A vault's declared tables, and the newest key version its rows are sealed under. */
export interface VaultTableStats {
  /** The newest master-key version any row in the vault is sealed under, or `null` for an empty vault. */
  newestKeyVersion: number | null;
  /** Every registered table, by name. */
  tables: SecretTableStats[];
}

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** Read a vault's declared-table stats. Read-only. */
export async function secretTableStats(db: SecretsDb): Promise<VaultTableStats> {
  const any = db.withTables<Record<string, DatabaseSchema<{ row: typeof AnyTableRow }>["row"]>>();
  const system = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select((eb) => eb.fn.max("keyVersion").as("newest"))
    .executeTakeFirst();
  let newest = system?.newest === null || system?.newest === undefined ? null : Number(system.newest);

  const registered = await registeredSecretTables(db);
  const names = new Map<string, string[]>();
  if (registered.length > 0) {
    for (const row of await db.selectFrom("pithySecretsTables").selectAll().execute()) {
      const parsed = SecretTableRegistration.safeParse(row);
      if (parsed.success) names.set(parsed.data.name, parsed.data.secrets);
    }
  }

  const tables: SecretTableStats[] = [];
  for (const table of [...registered].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const grouped = await any
      .selectFrom(table.identifier)
      .select((eb) => ["name", "keyVersion", eb.fn.countAll<number>().as("rows")])
      .groupBy(["name", "keyVersion"])
      .execute();
    const bySecret = new Map<string, SecretTableSecretStats>();
    for (const secret of names.get(table.name) ?? []) bySecret.set(secret, { name: secret, rows: 0, keyVersions: {} });
    for (const group of grouped) {
      const entry = bySecret.get(group.name) ?? { name: group.name, rows: 0, keyVersions: {} };
      const rows = Number(group.rows);
      entry.rows += rows;
      entry.keyVersions[String(group.keyVersion)] = rows;
      bySecret.set(group.name, entry);
      if (newest === null || group.keyVersion > newest) newest = group.keyVersion;
    }
    tables.push({ table: table.name, keys: table.keys, secrets: [...bySecret.values()] });
  }
  return { newestKeyVersion: newest, tables };
}

/** How many rows across these stats are sealed below the newest version — the rows a rotation did not reach. */
export function rowsBehind(stats: VaultTableStats): number {
  if (stats.newestKeyVersion === null) return 0;
  let behind = 0;
  for (const table of stats.tables) {
    for (const secret of table.secrets) {
      for (const [version, rows] of Object.entries(secret.keyVersions)) {
        if (Number(version) < stats.newestKeyVersion) behind += rows;
      }
    }
  }
  return behind;
}
