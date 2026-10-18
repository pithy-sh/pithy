// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { sql } from "kysely";
import { z } from "zod";
import { decryptValue, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { decodeVersionedValue, encodeVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import { SecretCryptoError } from "../error/errors";
import type { SecretValueType } from "../registry";
import { type AnySecretTable, secretTableContext } from "./defineSecretTable";

/**
 * The D1 half of a declared table: one statement per operation against `pithy_secrets_<name>_secrets`, sealed
 * through the same envelope `SystemSecretsStore` seals the system table with.
 *
 * **Typed loosely on purpose, and in one place.** A declared table's name and its key columns exist only at
 * runtime, so Kysely cannot know them from a schema map; {@link AnyTableRow} is the base row with a catch-all
 * for the key columns, built through `createDatabase` like every other Kysely instance in the kit so the
 * `CamelCasePlugin` and the bound-parameter guard come with it. Every key column name it is handed has been
 * held to the declaration's rule (`isSecretTableKeyName`) before it gets here.
 *
 * Nothing above this layer touches SQL, and nothing in it touches a plaintext beyond the one seal or open it
 * was asked for. Owner values never reach a `detail`: they identify a customer.
 */

/**
 * The base row every declared table carries, as Kysely sees it. The key columns are not in it — they are
 * named only at runtime, so every reference to one goes through `sql.ref` / `db.dynamic.ref`, which
 * `CamelCasePlugin` snake-cases like any other identifier.
 */
export const AnyTableRow = z
  .object({
    id: z.number().int().describe("Surrogate primary key."),
    name: z.string().describe("The secret name."),
    encryptedValue: z.string().describe("Base64 AES-256-GCM ciphertext."),
    iv: z.string().describe("Base64 initialization vector."),
    keyVersion: z.number().int().describe("Master-key version that sealed the row."),
    valueType: z.string().describe("How the plaintext is interpreted."),
    createdAt: SQLiteDate.describe("When the row was first written."),
    updatedAt: SQLiteDate.describe("When the row was last written."),
  })
  .describe("The base columns of any declared secret table; its owner key columns are addressed by name.");

/** Open the secrets D1 for declared tables, through the one Kysely seam — any table name, the base row. */
export function anyTableDb(d1: D1Database) {
  const tables: Record<string, typeof AnyTableRow> = {};
  return createDatabase(d1, tables);
}

/** A Kysely over the secrets D1 that can address any declared table by name. */
export type AnyTableDb = ReturnType<typeof anyTableDb>;

/** One row's listing — its owner and its metadata, never its value. */
export interface StoredTableRow {
  /** The owner keys the row is addressed by. */
  owner: Record<string, string>;
  /** The secret name the row holds. */
  name: string;
  /** The master-key version that sealed it. */
  keyVersion: number;
  /** When it was first written. */
  createdAt: Date;
  /** When it was last written. */
  updatedAt: Date;
}

/** The store's operations for one declared table — the seam `SecretTableAccessor` runs through. */
export class TableSecretsStore {
  readonly #db: AnyTableDb;
  readonly #config: EncryptionConfig;
  readonly #table: AnySecretTable;

  constructor(db: AnyTableDb, config: EncryptionConfig, table: AnySecretTable) {
    this.#db = db;
    this.#config = config;
    this.#table = table;
  }

  /** Build a store from the worker env — re-resolving the master key, so a key rotation is picked up. */
  static async fromEnv(env: SecretsStoreEnv, table: AnySecretTable): Promise<TableSecretsStore> {
    return new TableSecretsStore(anyTableDb(env.SECRETS), await resolveEncryptionConfig(env), table);
  }

  /** The `where` for a predicate: one equality per key given. */
  #matching(predicate: Readonly<Record<string, string>>) {
    let query = this.#db.selectFrom(this.#table.identifier);
    for (const [key, value] of Object.entries(predicate)) query = query.where(sql.ref(key), "=", value);
    return query;
  }

  /**
   * One owner's secret as its stored envelope, or `undefined` when nothing is stored. A row that will not open
   * throws `secrets/crypto_failed`, naming the table and the secret and never the owner.
   */
  async read(owner: Readonly<Record<string, string>>, name: string): Promise<VersionedValue | undefined> {
    const row = await this.#matching(owner)
      .select(["encryptedValue", "iv", "keyVersion"])
      .where("name", "=", name)
      .executeTakeFirst();
    if (!row) return undefined;
    try {
      const context = secretTableContext(this.#table.name, owner, name);
      return decodeVersionedValue(await decryptValue(this.#config, context, row));
    } catch {
      // No binding: what a decrypt throws names the context it tried, and the context holds the owner.
      throw new SecretCryptoError({
        message: `Secret '${name}' in table '${this.#table.name}' is stored and could not be read.`,
        detail: `secret table '${this.#table.name}': a '${name}' row did not decrypt`,
      });
    }
  }

  /**
   * Seal and write one owner's secret. `create` inserts only when no row exists — one statement, so two
   * racing creates leave the first — and answers whether it did. `replace` writes whatever was there.
   */
  async write(
    owner: Readonly<Record<string, string>>,
    name: string,
    value: VersionedValue,
    valueType: SecretValueType,
    mode: "create" | "replace",
  ): Promise<boolean> {
    const context = secretTableContext(this.#table.name, owner, name);
    const { encryptedValue, iv, keyVersion } = await encryptValue(this.#config, context, encodeVersionedValue(value));
    const now = SQLiteDate.encode(new Date());
    const row = Object.assign(
      { name, encryptedValue, iv, keyVersion, valueType, createdAt: now, updatedAt: now },
      owner,
    );
    // The conflict target is the owner index — every key, then the name — which SQLite requires to match a
    // unique index exactly.
    const target = sql.join([...this.#table.keyNames, "name"].map((column) => sql.ref(column)));
    const result = await this.#db
      .insertInto(this.#table.identifier)
      .values(row)
      .onConflict((conflict) =>
        mode === "create"
          ? conflict.expression(target).doNothing()
          : conflict.expression(target).doUpdateSet({ encryptedValue, iv, keyVersion, valueType, updatedAt: now }),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
  }

  /** Remove one owner's secret. Answers how many rows went — zero or one. */
  async delete(owner: Readonly<Record<string, string>>, name: string): Promise<number> {
    return this.deleteWhere({ ...owner }, name);
  }

  /** Every row matching the predicate — metadata only, ordered by owner then name. */
  async list(predicate: Readonly<Record<string, string>>): Promise<StoredTableRow[]> {
    const keys = this.#table.keyNames.map((key) => this.#db.dynamic.ref(key));
    let query = this.#matching(predicate).select([...keys, "name", "keyVersion", "createdAt", "updatedAt"]);
    for (const key of keys) query = query.orderBy(key);
    const rows = await query.orderBy("name").execute();
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        owner: Object.fromEntries(this.#table.keyNames.map((key) => [key, String(record[key] ?? "")])),
        name: String(record.name),
        keyVersion: Number(record.keyVersion),
        createdAt: SQLiteDate.parse(record.createdAt),
        updatedAt: SQLiteDate.parse(record.updatedAt),
      };
    });
  }

  /** Remove every row matching the predicate, narrowed to one secret name when given. Answers the count. */
  async deleteWhere(predicate: Readonly<Record<string, string>>, name?: string): Promise<number> {
    let query = this.#db.deleteFrom(this.#table.identifier);
    for (const [key, value] of Object.entries(predicate)) query = query.where(sql.ref(key), "=", value);
    if (name !== undefined) query = query.where("name", "=", name);
    const result = await query.executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }
}
