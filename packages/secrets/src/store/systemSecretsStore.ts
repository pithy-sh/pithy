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
import { SecretCryptoError } from "../error/errors";
import type { SecretValueType } from "../registry";

/** The Kysely instance the store queries — typed over the secrets tables, CamelCasePlugin installed. */
type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * One stored secret as a read found it: its envelope, or that the row is there and would not open (#384).
 *
 * **The state rides on the value**, so a caller cannot reach a plaintext without narrowing and forgetting
 * the unreadable case is a compile error rather than a silent empty. That is the shape `#350`, `#371` and
 * `#380` settled, and it is here for the reason it was there: this is a *batch* read, so an unreadable row
 * that throws is an unreadable row that costs every other name in the call. `#170` promised that a failure
 * belongs to its secret; it was true of a **missing** row and not of an **unreadable** one, which is a
 * narrower guarantee than the sentence reads.
 *
 * **Absent is a third fact and it is not in this union.** A name with no row is simply not a key in the
 * record `getValues` returns. Missing and unreadable are different faults with different remedies —
 * provision it, versus investigate the row or re-seal it — and folding either into the other loses the
 * only thing the operator needed.
 *
 * `unreadable` carries nothing. There is nothing safe to put on it: what the decrypt threw names a key
 * version and a ciphertext it could not open, and the row's own name is already the key this value is
 * filed under.
 */
export type StoredSecretValue =
  | {
      /** The row opened and its plaintext parsed as a value envelope. */
      state: "readable";
      /** The decrypted `{ currentVersion, versions }` envelope. */
      value: VersionedValue;
    }
  | {
      /** The row is stored and did not open — a corrupt ciphertext, or a key version no longer held. */
      state: "unreadable";
    };

/**
 * What a stored secret that will not open is told — the sibling of `secretsStore`'s `unprovisioned`, and
 * deliberately a different sentence with a different code.
 *
 * Constructed here rather than re-thrown from the decrypt, because nothing derived from that failure may
 * travel: the guard's `catch` takes no binding (`#350`), so there is no error object in scope to attach as
 * `cause` and no text to fold into `detail`. What survives is the name — never a ciphertext, an IV, or a
 * key version.
 *
 * **Only for a name a registry declares.** `message` crosses the HTTP boundary, so the name in it must be
 * one an operator wrote in a registry and not one a caller supplied. A keyspace member's stored name embeds
 * a tenant key; {@link SystemSecretsStore.getValue} keeps that out of `message` for exactly that reason.
 */
export function unreadableSecret(name: string): SecretCryptoError {
  return new SecretCryptoError({
    message: `Secret '${name}' is stored and could not be read.`,
    action:
      "Check SECRETS_ENCRYPTION_KEYS still holds the key version this row was sealed under. If it does not, re-seal the secret with `pithy secrets update`.",
    detail: `d1 secret '${name}' has a row that did not decrypt`,
  });
}

/**
 * Decrypt and parse one row, or answer that it would not open (#384).
 *
 * **The `catch` takes no binding, and that is the point rather than a tidiness.** A decryption failure's
 * own text names the key version it tried and the context it tried under; `decodeVersionedValue`'s names
 * the shape it found in a plaintext. Neither may reach a log, a response, or a held error, and a `catch`
 * with nothing bound makes that impossible to get wrong later rather than merely absent today.
 *
 * Both halves are inside it. A ciphertext that opens to something that is not an envelope is as unreadable
 * as one that does not open at all, and it arrives by the same routes.
 */
async function readRow(
  config: EncryptionConfig,
  row: { name: string; encryptedValue: string; iv: string; keyVersion: number },
): Promise<StoredSecretValue> {
  try {
    // The row's own name is the bound context: a ciphertext moved to another row does not open.
    return { state: "readable", value: decodeVersionedValue(await decryptValue(config, row.name, row)) };
  } catch {
    return { state: "unreadable" };
  }
}

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
   * Read every requested name that exists, each row's outcome on its own value (absent names omitted).
   *
   * The name list is the *application's* size, not a query's: `secretsStore` hands this every D1-backed
   * secret the registry declares, in one call, at boot. So it is chunked against D1's cap rather than
   * assumed to fit. Unchunked, an app declaring 101 of them read none of them, and because every
   * capability's secrets resolve through this one call, that is the whole Worker failing to start over a
   * limit nothing in a registry mentions (#250).
   *
   * **And for the same reason a row that will not open costs only itself (#384).** The decrypt used to run
   * in a bare loop, so one corrupt ciphertext — or one `keyVersion` orphaned by a master-key rotation —
   * threw out of the batch, and the caller above held that against *every* `d1` name in the read. An
   * unreadable `auth-github-credentials` therefore took `auth-session-secret` down with it, which is how
   * one unreadable OAuth credential ended every form of sign-in (#381). Each row is guarded now and lands
   * as a {@link StoredSecretValue} against its own name, which is what #170 promised.
   */
  async getValues(names: string[]): Promise<Record<string, StoredSecretValue>> {
    if (names.length === 0) return {};
    const out: Record<string, StoredSecretValue> = {};
    for (const chunk of chunkByBoundParameters(names, 0)) {
      const rows = await this.#db
        .selectFrom("pithySecretsSystemSecrets")
        .select(["name", "encryptedValue", "iv", "keyVersion"])
        .where("name", "in", chunk)
        .execute();

      for (const row of rows) out[row.name] = await readRow(this.#config, row);
    }
    return out;
  }

  /**
   * The value envelope for one secret, or `undefined` if it is not stored. A stored row that will not open
   * throws `secrets/crypto_failed`.
   *
   * **The union collapses here, and only here, because a batch of one has nothing to protect.** The state
   * rides on the value in {@link getValues} so that one bad row cannot cost its neighbors; asking for a
   * single name there are no neighbors, and every caller of this one — a keyspace member read, a rotate's
   * baseline, the dev seeder — wants the value or an exception. What it must *not* do is answer
   * `undefined`, which means "nothing is stored" and sends the reader to provision a row that is already
   * there.
   *
   * **The name goes in `detail` and never in `message`, which is why this is not {@link unreadableSecret}.**
   * That one is handed a registry literal. This one is handed a *stored* name, and for a keyspace member
   * that is the whole `<keyspace>/<key>` — a tenant identifier, supplied by a caller. `message` crosses the
   * HTTP boundary and `detail` is stripped there, so a sentence naming the secret would answer "which of
   * your tenants has a broken credential" to whoever could provoke it.
   */
  async getValue(name: string): Promise<VersionedValue | undefined> {
    const stored = (await this.getValues([name]))[name];
    if (!stored) return undefined;
    if (stored.state === "unreadable") {
      throw new SecretCryptoError({ detail: `stored secret '${name}' has a row that did not decrypt` });
    }
    return stored.value;
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
