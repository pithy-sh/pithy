// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { decryptValue, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { decodeVersionedValue, encodeVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import { type SecretsTables, secretsTables } from "../data/tables";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "../env/bindings";
import type { SecretValueType } from "../registry";

/** The Kysely instance the store queries — typed over the secrets tables, CamelCasePlugin installed. */
type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * The D1-backed encrypted store for `d1`-backed secrets, ported from the CMS `SystemSecretsStore`
 * with Pithy's universal value envelope layered on. Every secret's plaintext is a
 * `{ currentVersion, versions }` envelope (`crypto/versionedValue`), sealed in one AES-256-GCM
 * envelope (`crypto/envelope`) and persisted as one `pithy_secrets_system_secrets` row. The master
 * key is held only in memory, resolved once from the worker-only `SECRETS_ENCRYPTION_KEYS` binding.
 *
 * The store is the low-level read/write primitive: it persists and returns value envelopes. The
 * create/update/rotate *semantics* (which envelope to write) live above it — in the manager
 * Workflow and the CLI. Construct per request so a `SECRETS_ENCRYPTION_KEYS` rotation is picked up.
 */
export class SystemSecretsStore {
  readonly #db: SecretsDb;
  readonly #config: EncryptionConfig;

  constructor(db: SecretsDb, config: EncryptionConfig) {
    this.#db = db;
    this.#config = config;
  }

  /** Build a store from the worker env: its `SECRETS` D1 and resolved master-key config. */
  static async fromEnv(env: SecretsStoreEnv): Promise<SystemSecretsStore> {
    const config = await resolveEncryptionConfig(env);
    return new SystemSecretsStore(createDatabase(env.SECRETS, secretsTables), config);
  }

  /**
   * Decrypt and return the value envelopes for every requested name that exists (absent names omitted).
   *
   * The name list is the *application's* size, not a query's: `secretsStore` hands this every D1-backed
   * secret the registry declares, in one call, at boot. So it is chunked against D1's cap rather than
   * assumed to fit. Unchunked, an app declaring 101 of them read none of them, and because every
   * capability's secrets resolve through this one call, that is the whole Worker failing to start over a
   * limit nothing in a registry mentions (#250).
   */
  async getValues(names: string[]): Promise<Record<string, VersionedValue>> {
    if (names.length === 0) return {};
    const out: Record<string, VersionedValue> = {};
    for (const chunk of chunkByBoundParameters(names, 0)) {
      const rows = await this.#db
        .selectFrom("pithySecretsSystemSecrets")
        .select(["name", "encryptedValue", "iv", "keyVersion"])
        .where("name", "in", chunk)
        .execute();

      for (const row of rows) {
        // The row's own name is the bound context: a ciphertext moved to another row does not open.
        const plaintext = await decryptValue(this.#config, row.name, row);
        out[row.name] = decodeVersionedValue(plaintext);
      }
    }
    return out;
  }

  /** The value envelope for one secret, or `undefined` if it is not stored. */
  async getValue(name: string): Promise<VersionedValue | undefined> {
    return (await this.getValues([name]))[name];
  }

  /** Whether a secret with this name is stored. */
  async has(name: string): Promise<boolean> {
    const row = await this.#db
      .selectFrom("pithySecretsSystemSecrets")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Encrypt `value` under the current key version and upsert the row. Inserts on first write,
   * updates the envelope in place otherwise. `name` is sealed into the ciphertext as authenticated
   * data (`crypto/envelope`), so a rename has to go through here and not through SQL: an
   * `UPDATE ... SET name` leaves a row nothing can open. The caller owns the envelope's shape —
   * `initialVersionedValue` for a create, an edited envelope for an update, `appendVersion` for a
   * value rotation.
   */
  async put(name: string, value: VersionedValue, valueType: SecretValueType = "text"): Promise<void> {
    const { encryptedValue, iv, keyVersion } = await encryptValue(this.#config, name, encodeVersionedValue(value));
    const now = SQLiteDate.encode(new Date());

    if (await this.has(name)) {
      await this.#db
        .updateTable("pithySecretsSystemSecrets")
        .set({ encryptedValue, iv, keyVersion, valueType, updatedAt: now })
        .where("name", "=", name)
        .execute();
      return;
    }
    await this.#db
      .insertInto("pithySecretsSystemSecrets")
      .values({ name, encryptedValue, iv, keyVersion, valueType, createdAt: now, updatedAt: now })
      .execute();
  }

  /** Remove a secret. A no-op if it does not exist. */
  async delete(name: string): Promise<void> {
    await this.#db.deleteFrom("pithySecretsSystemSecrets").where("name", "=", name).execute();
  }

  /** Every stored secret name, sorted — the metadata `ls` reads without touching values. */
  async listNames(): Promise<string[]> {
    const rows = await this.#db.selectFrom("pithySecretsSystemSecrets").select("name").orderBy("name").execute();
    return rows.map((row) => row.name);
  }
}
