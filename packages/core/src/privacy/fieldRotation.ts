// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Capability } from "../capability/capability";
import { decryptValue, EncryptedEnvelope, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import { FIELD_KEYS_BINDING, type FieldKeys, liveVersions, resolveFieldKeys } from "../crypto/fieldKeys";
import { InternalError } from "../error/pithyError";
import { blindIndexValue } from "./blindIndex";
import { deriveEncryptedColumns, type EncryptedColumn, type EncryptedColumnStamp } from "./encryptedColumns";
import { type RetirementVerdict, retirementVerdict, versionsDue } from "./retirement";
import { fieldContext } from "./sealed";

/**
 * **Re-sealing an encrypted column in place, and the guard on retiring a version** (#390).
 *
 * Rotation is lazy: every write seals under the current version, so a row moves off an old key the next time it is
 * written, and nothing re-seals between rotations. At each rotation the manager's rotator adds a version, re-seals the
 * rows still under the version **leaving the window** — and only those — and retires it once the guard reads clean.
 * The SQL that finds those rows, re-seals one, and counts what is left lives here, beside the derivation it reads, so
 * the rotator and the app Worker's own retirement report count one way.
 *
 * - **A stale row is found by `json_extract`, not by a scan of plaintext.** An envelope carries its `keyVersion` in
 *   the clear, and a blind index its version prefix, so the count and the batch are one indexed-or-not `WHERE`.
 * - **Each re-seal is a compare-and-swap** on the version it read: `UPDATE … WHERE <pk> = ? AND json_extract(col,
 *   '$.keyVersion') = <version read>`. A row the application re-sealed in between is skipped, never overwritten.
 * - **A field inside a JSON column** is an envelope JSON string at its JSON path, so its version is
 *   `json_extract(json_extract(col, '$.path'), '$.keyVersion')` and its re-seal is a `json_set` of that path.
 */

/** Quote a SQL identifier. Every identifier here comes from a validated stamp; this keeps it an identifier. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** The SQL that reads the key version of a column's envelope. */
function envelopeVersion(column: EncryptedColumn): string {
  const col = quote(column.column);
  return column.jsonPath === null
    ? `json_extract(${col}, '$.keyVersion')`
    : `json_extract(json_extract(${col}, '${column.jsonPath}'), '$.keyVersion')`;
}

/** The SQL that reads the version prefix of a blind-index value. */
function indexVersion(indexColumn: string): string {
  const col = quote(indexColumn);
  return `CAST(substr(${col}, 1, instr(${col}, ':') - 1) AS INTEGER)`;
}

/** The SQL predicate a row is stale under: its envelope, or its index, carries one of `count` versions. */
function stalePredicate(column: EncryptedColumn, count: number): string {
  const marks = Array.from({ length: count }, () => "?").join(", ");
  const envelope = `${envelopeVersion(column)} IN (${marks})`;
  return column.index ? `(${envelope} OR ${indexVersion(column.index.column)} IN (${marks}))` : envelope;
}

/** The bindings for {@link stalePredicate}. */
function staleBindings(column: EncryptedColumn, versions: readonly number[]): number[] {
  return column.index ? [...versions, ...versions] : [...versions];
}

/** How many rows of one column still hold an envelope or an index under any of `versions`. */
export async function countStale(
  d1: D1Database,
  column: EncryptedColumn,
  versions: readonly number[],
): Promise<number> {
  if (versions.length === 0) return 0;
  const row = await d1
    .prepare(`SELECT COUNT(*) AS count FROM ${quote(column.table)} WHERE ${stalePredicate(column, versions.length)}`)
    .bind(...staleBindings(column, versions))
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** One stale row, as a batch reads it. */
interface StaleRow {
  pk: string;
  stored: string | null;
  index: string | null;
}

/** One batch's outcome. */
export interface ResealResult {
  /** Rows re-sealed and re-indexed under the current version. */
  resealed: number;
  /** Rows the application re-sealed between the read and the write: left alone. */
  skipped: number;
  /** Rows that would not open. Never described: what failed to open is ciphertext. */
  failed: number;
}

/** The envelope a stored column holds at the field's path, or `null` where it holds none. */
function envelopeAt(column: EncryptedColumn, stored: string | null): EncryptedEnvelope | null {
  if (stored === null) return null;
  let value: unknown = JSON.parse(stored);
  if (column.jsonPath !== null) {
    for (const segment of column.jsonPath.slice(2).split(".")) {
      if (typeof value !== "object" || value === null) return null;
      value = (value as Record<string, unknown>)[segment];
    }
    if (value === undefined || value === null) return null;
    value = typeof value === "string" ? JSON.parse(value) : value;
  }
  if (value === null) return null;
  return EncryptedEnvelope.parse(value);
}

/**
 * Re-seal one batch of a column's rows still under `version`, onto `config`'s current version, re-indexing each in
 * the same write. Every write is a compare-and-swap on the version read, so a row the application re-sealed in
 * between is skipped. A row that will not open is counted and left, never described.
 */
export async function resealBatch(
  d1: D1Database,
  column: EncryptedColumn,
  config: EncryptionConfig,
  version: number,
  limit: number,
): Promise<ResealResult> {
  const result: ResealResult = { resealed: 0, skipped: 0, failed: 0 };
  const current = Number(config.currentVersion);
  const index = column.index ? `, ${quote(column.index.column)} AS "index"` : `, NULL AS "index"`;
  const { results } = await d1
    .prepare(
      `SELECT ${quote(column.primaryKey)} AS pk, ${quote(column.column)} AS stored${index} FROM ${quote(column.table)} WHERE ${stalePredicate(column, 1)} LIMIT ?`,
    )
    .bind(...staleBindings(column, [version]), limit)
    .all<StaleRow>();
  for (const row of results) {
    let envelope: EncryptedEnvelope | null;
    let plaintext: string | null = null;
    let sealed: EncryptedEnvelope | null = null;
    let indexValue: string | null = row.index;
    try {
      envelope = envelopeAt(column, row.stored);
      const context = fieldContext(column.name, column.path, String(row.pk));
      if (envelope !== null) {
        plaintext = await decryptValue(config, context, envelope, { keys: FIELD_KEYS_BINDING });
        sealed = await encryptValue(config, context, plaintext, { keys: FIELD_KEYS_BINDING });
      }
      if (column.index && plaintext !== null) {
        const value: unknown = JSON.parse(plaintext);
        if (typeof value !== "string") throw new InternalError({ detail: "an indexed field opened to a non-string" });
        indexValue = await blindIndexValue(config, current, column.index.normalizer, value);
      }
    } catch {
      // No binding: what failed to open is ciphertext, and its text belongs nowhere.
      result.failed += 1;
      continue;
    }
    const readVersion = envelope?.keyVersion ?? null;
    const set: string[] = [];
    const values: unknown[] = [];
    if (sealed !== null) {
      if (column.jsonPath === null) {
        set.push(`${quote(column.column)} = ?`);
      } else {
        set.push(`${quote(column.column)} = json_set(${quote(column.column)}, '${column.jsonPath}', ?)`);
      }
      values.push(JSON.stringify(sealed));
    }
    if (column.index) {
      set.push(`${quote(column.index.column)} = ?`);
      values.push(indexValue);
    }
    if (set.length === 0) {
      result.failed += 1;
      continue;
    }
    const swapped = await d1
      .prepare(
        `UPDATE ${quote(column.table)} SET ${set.join(", ")} WHERE ${quote(column.primaryKey)} = ? AND ${envelopeVersion(column)} IS ?${column.index ? ` AND ${quote(column.index.column)} IS ?` : ""}`,
      )
      .bind(...values, row.pk, readVersion, ...(column.index ? [row.index] : []))
      .run();
    if ((swapped.meta.changes ?? 0) > 0) result.resealed += 1;
    else result.skipped += 1;
  }
  return result;
}

/** Whether an `env` slot is a D1 binding. */
function isD1(value: unknown): value is D1Database {
  return typeof value === "object" && value !== null && typeof (value as { prepare?: unknown }).prepare === "function";
}

/**
 * **This Worker's own retirement verdict**, for the manifest's posture block: the guard over its own capabilities'
 * encrypted columns, read through its own D1 bindings and its own `PITHY_FIELD_KEYS`. The same derivation and the
 * same counts the rotator acts on, so what the dashboard shows is what the rotator would decide.
 *
 * **It never throws.** A derivation that refuses, a key set that will not resolve, a binding the Worker lacks and a
 * count that fails are each incomplete coverage: the guard could not read something, so it is not clean.
 */
export async function readRetirement(
  env: Record<string, unknown>,
  capabilities: readonly Capability[],
): Promise<RetirementVerdict> {
  let stamp: EncryptedColumnStamp;
  try {
    stamp = deriveEncryptedColumns(capabilities);
  } catch {
    return retirementVerdict({ versions: [], stale: 0, coverageComplete: false, unrotatable: 0 });
  }
  const keys = env[FIELD_KEYS_BINDING];
  let coverageComplete = true;
  let versions: number[] = [];
  if (stamp.columns.length > 0 || keys !== undefined) {
    try {
      versions = liveVersions(await resolveFieldKeys(keys as FieldKeys | undefined));
    } catch {
      coverageComplete = false;
    }
  }
  const due = versionsDue(versions);
  let stale = 0;
  for (const column of stamp.columns) {
    const d1 = env[column.binding];
    if (!isD1(d1)) {
      coverageComplete = false;
      continue;
    }
    try {
      stale += await countStale(d1, column, due);
    } catch {
      coverageComplete = false;
    }
  }
  return retirementVerdict({ versions, stale, coverageComplete, unrotatable: stamp.unrotatable.length });
}
