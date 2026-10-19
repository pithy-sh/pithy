// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditOutcome } from "@pithy-sh/core/src/audit/auditEvent";
import { ConflictError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type SecretsAuditAction, SecretsAuditActions } from "../audit/actions";
import { appendVersion, currentValue, initialVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import type { SecretsStoreEnv } from "../env/bindings";
import { SecretAlreadyExistsError, SecretNotFoundError } from "../error/errors";
import type { KeyedWriteAudit, KeyedWriteResult } from "../secretsStore";
import { parseValue, serializeValue } from "../store/entryValue";
import {
  type AnySecretTable,
  type SecretTableOwner,
  type SecretTableOwnerPredicate,
  type SecretTableSecret,
  type SecretTableSecretName,
  type SecretTableValue,
  secretTableOwner,
  secretTablePredicate,
} from "./defineSecretTable";
import { type StoredTableRow, TableSecretsStore } from "./tableStore";

/**
 * `secretsStore(env, registry).table(T)` — read and write one declared table's secrets, on the request.
 *
 * The keyed accessor's rules, carried across unchanged because they were right there: **create-only by
 * default** (`put` refuses an existing row; `{ replace: true }` discards it), **rotate appends** a version
 * and keeps the prior one valid, **delete is idempotent** and never says whether anything was there, and
 * **every refusal names the table and the secret and never the owner** — `detail` reaches logs verbatim, and
 * an owner key identifies a customer.
 *
 * What a keyspace could not do is the reason this exists: `list` and `deleteWhere` take **any subset** of
 * the declared keys, so *what does this organization hold* and *offboard this tenant* are one call each, on
 * an indexed column, rather than a prefix scan the adopter writes against our table.
 *
 * Nothing is cached. The store is built per operation so it re-resolves the master key, as a keyspace
 * member's is — one owner's credential must not sit in an accessor the next request reuses.
 */

/** How many times `rotate` redoes its append over a row a concurrent write changed, before it gives up. */
const ROTATE_ATTEMPTS = 3;

/** Options for {@link SecretTableAccessor.put}. */
export interface TablePutOptions {
  /** Discard whatever is stored for this owner and secret, and write a fresh single-version value. */
  replace?: boolean;
  /** Record the write in the audit trail. */
  audit?: KeyedWriteAudit;
}

/** Options for the other writes. */
export interface TableWriteOptions {
  /** Record the write in the audit trail. */
  audit?: KeyedWriteAudit;
}

/** One owner's secret, as a listing shows it: owner, name, and metadata — never the value. */
export interface SecretTableRow<T extends AnySecretTable> {
  /** The owner keys this row is addressed by. */
  owner: SecretTableOwner<T>;
  /** The secret name it holds. */
  name: SecretTableSecretName<T>;
  /** The master-key version that sealed it — the at-rest rotation moves it. */
  keyVersion: number;
  /** When it was first written. */
  createdAt: Date;
  /** When it was last written. */
  updatedAt: Date;
}

/** A secret's resolved versions: the current pointer plus every still-valid version. */
export interface TableVersions<V> {
  /** The version key whose value is current. */
  currentVersion: string;
  /** Every still-valid version: version key → value. */
  versions: Record<string, V>;
}

/** Opens one declared table's store. The seam the accessor is built with, so the shared store can rebind it. */
export type SecretTableIO = (table: AnySecretTable) => Promise<TableSecretsStore>;

/** The real one: the per-environment secrets D1, re-resolving the master key per operation. */
export function d1TableIO(env: SecretsStoreEnv): SecretTableIO {
  return (table) => TableSecretsStore.fromEnv(env, table);
}

/** The typed accessor over one declared table. */
export class SecretTableAccessor<T extends AnySecretTable> {
  readonly #table: T;
  readonly #open: SecretTableIO;

  constructor(table: T, open: SecretTableIO) {
    this.#table = table;
    this.#open = open;
  }

  /** The current value of one owner's secret. */
  async get<N extends SecretTableSecretName<T>>(owner: SecretTableOwner<T>, name: N): Promise<SecretTableValue<T, N>> {
    const { entry, stored } = await this.#load(owner, name);
    return parseValue(entry, name, currentValue(stored)) as SecretTableValue<T, N>;
  }

  /** The current pointer plus every still-valid version of one owner's secret — what a verifier mid-rotation needs. */
  async getVersions<N extends SecretTableSecretName<T>>(
    owner: SecretTableOwner<T>,
    name: N,
  ): Promise<TableVersions<SecretTableValue<T, N>>> {
    const { entry, stored } = await this.#load(owner, name);
    const versions: Record<string, SecretTableValue<T, N>> = {};
    for (const [version, raw] of Object.entries(stored.versions)) {
      versions[version] = parseValue(entry, name, raw) as SecretTableValue<T, N>;
    }
    return { currentVersion: stored.currentVersion, versions };
  }

  /**
   * Store one owner's secret, sealed under the current master key. **Create-only by default**: an existing row
   * is refused with `secrets/already_exists`, and `{ replace: true }` discards it. The promise resolving is
   * the persistence guarantee.
   */
  async put<N extends SecretTableSecretName<T>>(
    owner: SecretTableOwner<T>,
    name: N,
    value: SecretTableValue<T, N>,
    options: TablePutOptions = {},
  ): Promise<KeyedWriteResult> {
    const mode = options.replace ? "replace" : "create";
    // Either mode may insert, so the owner is a new row's: every key held to its schema, `""` included.
    const { entry, valid } = this.#prepare(owner, name, { creating: true });
    const serialized = serializeValue(entry, name, value);
    const audit = (outcome: AuditOutcome) =>
      this.#audit(options.audit, SecretsAuditActions.tableSecretWritten, outcome, name, valid, { mode });
    try {
      const store = await this.#open(this.#table);
      const next = initialVersionedValue(serialized);
      const written = await store.write(valid, name, next, entry.valueType, mode);
      if (!written) {
        throw new SecretAlreadyExistsError({
          message: `Secret '${name}' in table '${this.#table.name}' already has a value for that owner.`,
          action: "Rotate it to add a version, or pass replace to discard the stored one.",
          detail: `secret table '${this.#table.name}': create found a '${name}' row already stored for the owner`,
        });
      }
      await audit("success");
      return { currentVersion: next.currentVersion };
    } catch (error) {
      await audit("failure");
      throw error;
    }
  }

  /** Add a new current value for one owner's secret, keeping every prior version valid. The secret must be rotatable. */
  async rotate<N extends SecretTableSecretName<T>>(
    owner: SecretTableOwner<T>,
    name: N,
    value: SecretTableValue<T, N>,
    options: TableWriteOptions = {},
  ): Promise<KeyedWriteResult> {
    const { entry, valid } = this.#prepare(owner, name);
    if (!entry.rotatable) {
      throw new InternalError({
        message: `Secret '${name}' in table '${this.#table.name}' does not accumulate versions.`,
        action: "Declare it rotatable, or replace the value with put(owner, name, value, { replace: true }).",
        detail: `rotate called on '${name}' in table '${this.#table.name}', which is declared rotatable: false`,
      });
    }
    const serialized = serializeValue(entry, name, value);
    const audit = (outcome: AuditOutcome) =>
      this.#audit(options.audit, SecretsAuditActions.tableSecretRotated, outcome, name, valid);
    try {
      const store = await this.#open(this.#table);
      const next = await this.#appendGuarded(store, valid, name, entry, serialized);
      await audit("success");
      return { currentVersion: next.currentVersion };
    } catch (error) {
      await audit("failure");
      throw error;
    }
  }

  /** Remove one owner's secret, every version of it. Idempotent, and it never reports whether anything was there. */
  async delete<N extends SecretTableSecretName<T>>(
    owner: SecretTableOwner<T>,
    name: N,
    options: TableWriteOptions = {},
  ): Promise<void> {
    const { valid } = this.#prepare(owner, name);
    const audit = (outcome: AuditOutcome) =>
      this.#audit(options.audit, SecretsAuditActions.tableSecretRemoved, outcome, name, valid);
    try {
      await (await this.#open(this.#table)).delete(valid, name);
    } catch (error) {
      await audit("failure");
      throw error;
    }
    await audit("success");
  }

  /** Every secret an owner holds — any non-empty subset of the keys. Metadata only, never a value. */
  async list(predicate: SecretTableOwnerPredicate<T>): Promise<SecretTableRow<T>[]> {
    const valid = secretTablePredicate(this.#table, predicate);
    const rows: StoredTableRow[] = await (await this.#open(this.#table)).list(valid);
    // The store reads the declared key columns and the declared names, so these are the table's own types.
    return rows.map((row) => ({
      ...row,
      owner: row.owner as SecretTableOwner<T>,
      name: row.name as SecretTableSecretName<T>,
    }));
  }

  /**
   * Remove every row matching the owner — `{ organizationId }` offboards a tenant, `{ userId }` deletes a user
   * — and answer how many went. `{}` is refused: it would mean every owner at once.
   */
  async deleteWhere(predicate: SecretTableOwnerPredicate<T>, options: TableWriteOptions = {}): Promise<number> {
    const valid = secretTablePredicate(this.#table, predicate);
    let removed: number;
    try {
      removed = await (await this.#open(this.#table)).deleteWhere(valid);
    } catch (error) {
      await this.#auditOwner(options.audit, "failure", valid, null);
      throw error;
    }
    await this.#auditOwner(options.audit, "success", valid, removed);
    return removed;
  }

  /**
   * Read, append, and write back over exactly the row that was read. **Update-only**: an upsert here would
   * re-insert a row a `deleteWhere` removed between the two statements, and bring an offboarded owner's
   * credential back. A row rewritten in that window — a `put` with `replace`, another `rotate` — fails the
   * guard, and the append is redone over what is there now rather than discarding it. A row gone is not found.
   */
  async #appendGuarded(
    store: TableSecretsStore,
    owner: Record<string, string>,
    name: string,
    entry: SecretTableSecret,
    serialized: string,
  ): Promise<VersionedValue> {
    for (let attempt = 0; attempt < ROTATE_ATTEMPTS; attempt++) {
      const existing = await store.readSealed(owner, name);
      if (!existing) throw this.#missing(name);
      const next = appendVersion(existing.value, serialized);
      if (await store.update(owner, name, next, entry.valueType, existing.iv)) return next;
    }
    throw new ConflictError({
      message: `Secret '${name}' in table '${this.#table.name}' kept changing while it was rotated.`,
      action: "Rotate it again. Something else is writing this owner's secret in a loop.",
      detail: `secret table '${this.#table.name}': rotate lost the row to a concurrent write ${ROTATE_ATTEMPTS} times`,
    });
  }

  /** Prove the name is declared and the owner is whole, before anything touches the store. */
  #prepare(
    owner: Record<string, unknown>,
    name: string,
    options: { creating?: boolean } = {},
  ): { entry: SecretTableSecret; valid: Record<string, string> } {
    const entry = this.#table.secrets[name];
    if (!entry) {
      throw new SecretNotFoundError({
        message: `Secret table '${this.#table.name}' declares no secret of that name.`,
        detail: `secret table '${this.#table.name}': '${name}' is not declared`,
      });
    }
    return { entry, valid: secretTableOwner(this.#table, owner, options) };
  }

  /** One owner's stored envelope, or the not-found that names the table and never the owner. */
  async #load(
    owner: Record<string, unknown>,
    name: string,
  ): Promise<{ entry: SecretTableSecret; stored: VersionedValue }> {
    const { entry, valid } = this.#prepare(owner, name);
    const stored = await (await this.#open(this.#table)).read(valid, name);
    if (!stored) throw this.#missing(name);
    return { entry, stored };
  }

  #missing(name: string): SecretNotFoundError {
    return new SecretNotFoundError({
      message: `Secret '${name}' in table '${this.#table.name}' has no value for that owner.`,
      detail: `secret table '${this.#table.name}': no '${name}' row stored for the owner`,
    });
  }

  /**
   * Record one write. The owner keys are the point of the event — a trail that cannot be read per customer
   * is not a trail for this table — and they are legitimate there because they have already been validated
   * against the declaration. Nothing about the value is here, and nothing about it is in scope to put here.
   * `emit` never throws by contract, so a write is never broken by its own audit.
   */
  async #audit(
    audit: KeyedWriteAudit | undefined,
    action: SecretsAuditAction,
    outcome: AuditOutcome,
    name: string,
    owner: Record<string, string>,
    extra: Record<string, string> = {},
  ): Promise<void> {
    if (!audit) return;
    await audit.emit({
      action,
      outcome,
      severity: outcome === "success" ? "info" : "warning",
      actorType: audit.actorType,
      actorId: audit.actorId,
      sessionId: audit.sessionId,
      requestId: audit.requestId,
      resourceType: "secret",
      resourceId: `${this.#table.name}/${name}`,
      metadata: { table: this.#table.name, secret: name, owner, ...extra },
    });
  }

  /** Record an owner-wide removal: the predicate, and how many rows went. */
  async #auditOwner(
    audit: KeyedWriteAudit | undefined,
    outcome: AuditOutcome,
    owner: Record<string, string>,
    removed: number | null,
  ): Promise<void> {
    if (!audit) return;
    await audit.emit({
      action: SecretsAuditActions.tableOwnerRemoved,
      outcome,
      // A routine offboarding is routine; one that failed may have left a departed owner's credential live.
      severity: outcome === "success" ? "info" : "warning",
      actorType: audit.actorType,
      actorId: audit.actorId,
      sessionId: audit.sessionId,
      requestId: audit.requestId,
      resourceType: "secret",
      resourceId: this.#table.name,
      metadata: removed === null ? { table: this.#table.name, owner } : { table: this.#table.name, owner, removed },
    });
  }

  /** Redacted serialization. */
  toJSON(): string {
    return `[SecretTable ${this.#table.name}]`;
  }
}
