// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretRotation } from "@pithy-sh/core/src/capability/secretOrigin";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { RotationStatus, RotationTrigger } from "../data/secretRotations";
import type { SecretsTables } from "../data/tables";
import { SecretBackend, type SecretRegistry, SecretValueType } from "../registry";

/**
 * The read behind "is any secret overdue" — metadata about secrets, and never a secret.
 *
 * ## The one constraint everything here is arranged around
 *
 * A status read must not be able to disclose a value. Not "the projection happens to omit it" — the
 * shapes below must be **incapable** of carrying one, so widening them is a compile error rather than a
 * review somebody has to catch. `packages/auth/src/admin/users.ts` states the first half of the rule:
 * *a projection cannot leak a column that was not selected*. This file adds the second: a type that has
 * no field for a value cannot be handed one, whatever a future query selects.
 *
 * Four layers, because each catches what the others cannot:
 *
 * 1. **The queries name their columns.** `encrypted_value` and `iv` never reach the Worker's memory on
 *    a status read, so nothing downstream can leak them by accident.
 * 2. **The shapes are Zod objects and rows are parsed through them**, so an unknown column is stripped
 *    rather than passed along — a `selectAll()` written here later still discloses nothing.
 * 3. **{@link SECRET_STATUS_CARRIES_NO_VALUE} is a compile-time tripwire.** Adding a banned field to
 *    either shape makes this module fail to typecheck.
 * 4. **`status.test.ts` asserts the exact field set**, so *any* new field — not only a banned one — has
 *    to be argued for by somebody editing a test that says why.
 *
 * ## `errorMessage` and `metadataSnapshot` are refused, and they are the interesting ones
 *
 * Both columns exist on `pithy_secrets_rotations` and neither is exposed. They are free text written at
 * a failure site, which is precisely where a value gets pasted by accident — an exception message that
 * interpolated what it was decrypting, a snapshot taken "for debugging". A failed rotation is still
 * reported: {@link SecretRotationRecord.status} says `failed`, which is the fact an owner acts on. If a
 * reason is ever wanted it belongs here as a **code** the capability defines, never as the message.
 *
 * ## What is reported, and what is deliberately not
 *
 * One row per **named** registry entry, from the registry the Worker actually composed — so a status
 * read covers every capability's secrets (auth's signing key, email's link key), not only the ones the
 * adopter typed. Keyed entries are excluded: a keyspace has no single value, and its members are
 * per-tenant rows created at runtime, so listing them would turn a status read into a tenant
 * enumeration. Stored rows that no registry entry names are excluded for the same reason — reaching
 * them means listing the table, and the table is where keyspace members live.
 *
 * The whole-store at-rest key rotation records itself under a sentinel name (`AT_REST_ROTATION_NAME`)
 * that no registry entry can carry, so it falls out of every query here without a filter. It is an
 * event about the store, not about a secret.
 */

/** The Kysely instance these reads run against — typed over the secrets tables, CamelCasePlugin installed. */
export type SecretsStatusDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * Field names that would carry a secret's value, the envelope around it, or free text written where a
 * value is in scope. Named as a type so the tripwire below is a list somebody has to delete from rather
 * than a rule somebody has to remember.
 */
type ValueBearing = "encryptedValue" | "iv" | "value" | "plaintext" | "metadataSnapshot" | "errorMessage";

/**
 * `true` when `T` names none of {@link ValueBearing}, and `never` when it names any — so an assignment
 * of `true` to this type stops compiling the moment a shape is widened.
 *
 * The tuple wrapper is not decoration: a bare `Extract<...> extends never` on a union would distribute
 * and answer `true` for every member, which is the one way this check could quietly pass.
 */
export type CarriesNoValue<T> = [Extract<keyof T, ValueBearing>] extends [never] ? true : never;

/**
 * One rotation attempt, as an owner may see it: when, how it ended, what caused it, and who.
 *
 * Ordered newest first by the reader. `completedAt` null with status `in_progress` is a rotation still
 * running; a `failed` row says only that it failed, on purpose — see the file comment.
 */
export const SecretRotationRecord = z
  .object({
    startedAt: SQLiteDate.describe("When the rotation attempt began. Ms-epoch in SQLite, a `Date` here."),
    completedAt: SQLiteDate.nullable().describe(
      "When it finished, or null while it is still running. Ms-epoch in SQLite, a `Date` here.",
    ),
    status: RotationStatus.describe(
      "How it ended: `in_progress`, `success`, or `failed`. A failure reports as a status and never as a message.",
    ),
    trigger: RotationTrigger.describe(
      "What caused it — a scheduled `cron` run, a `manual` action, or the `baseline` marker written when a secret is first stored.",
    ),
    rotatedBy: z.string().describe("Who or what initiated it: a workflow instance id, an operator id, or `baseline`."),
  })
  .describe("One rotation attempt, in metadata only. Carries no value, no ciphertext, and no failure text.");
export type SecretRotationRecord = z.output<typeof SecretRotationRecord>;

/**
 * One secret's status: what the registry declares about it, what the store knows about it, and whether
 * it is late.
 *
 * **Null is load-bearing in three different ways here, and they are not the same fact.**
 * `lastRotatedAt: null` means never rotated — which is not zero, not the epoch, and not "rotated a long
 * time ago". `createdAt: null` means nothing is stored under this name in the secrets D1: either the
 * secret was declared and never written, or it lives in Cloudflare's Secrets Store, which is why
 * {@link SecretStatus.backend} is reported — without it the nulls are unreadable. `overdue: null` means
 * the question has no answer, either because no cadence is declared or because there is no date to
 * measure from.
 */
export const SecretStatus = z
  .object({
    name: z.string().describe("The secret's registry name."),
    backend: SecretBackend.describe(
      "Where the value physically lives. Reported because it decides what a null `createdAt` means: a `cf-secrets-store` secret never has a row in this database.",
    ),
    valueType: SecretValueType.describe("How the value is interpreted, from the registry: `text` or `json`."),
    rotatable: z
      .boolean()
      .describe(
        "Whether a value-rotator may manage this secret. It changes what automation may do and never what an owner may see — a `false` secret reports exactly like a `true` one.",
      ),
    rotation: SecretRotation.nullable().describe(
      "How this secret is replaced, from its registry entry: `local` (the kit mints another), `provider` (its issuer is called and returns one), or `manual` (a human in a console, with the issuer and the page named). Null when the entry declares none, which is a different fact from `manual` — nobody has said, rather than somebody has said it takes a human. **Not derivable from `rotatable`, and not a duplicate of it**: `SECRETS_ENCRYPTION_KEYS` is `local` and `rotatable: false`, while a payments credential is `rotatable: true` and rotates only by hand. Metadata by construction — a kind, an issuer and a documentation URL, none of which a value fits in.",
    ),
    keyVersion: z
      .number()
      .int()
      .nullable()
      .describe(
        "Which master-key version the stored envelope sits under, or null when nothing is stored here. A number, never key material.",
      ),
    createdAt: SQLiteDate.nullable().describe(
      "When the secret was first written to this store, or null when it is not stored here.",
    ),
    updatedAt: SQLiteDate.nullable().describe("When its value was last written, or null when it is not stored here."),
    lastRotatedAt: SQLiteDate.nullable().describe(
      "The newest rotation that completed successfully, or **null for never rotated** — which is a different fact from rotated long ago, and must not render as one.",
    ),
    rotationCount: z
      .number()
      .int()
      .nonnegative()
      .describe("How many rotation attempts are recorded for this secret, successful or not."),
    rotateEveryDays: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe(
        "The cadence the registry declares for this secret, or null when it declares none. The capability's own statement of what late means.",
      ),
    overdue: z
      .boolean()
      .nullable()
      .describe(
        "Whether it is past its declared cadence. Null when the question has no answer: no cadence declared, or nothing to measure from.",
      ),
  })
  .describe("One secret's status — registry declaration, store metadata, and freshness. Never a value.");
export type SecretStatus = z.output<typeof SecretStatus>;

/**
 * The compile-time half of the constraint. `true` only while neither shape names a value-bearing field;
 * add one and this assignment fails, naming the file rather than waiting for a reviewer.
 */
export const SECRET_STATUS_CARRIES_NO_VALUE: CarriesNoValue<SecretStatus> & CarriesNoValue<SecretRotationRecord> = true;

/** Milliseconds in a day. Cadences are declared in days because that is the unit people reason about. */
const MS_PER_DAY = 86_400_000;

/**
 * Whether a secret is past its declared cadence.
 *
 * Returns null rather than false when it cannot be decided — no cadence declared, or no date to measure
 * from. False would claim the secret is fine, which is a different and more comfortable answer than
 * "nobody has said what fine is", and comfort is the wrong default on this surface.
 */
export function overdueAgainst(reference: Date | null, rotateEveryDays: number | null, now: Date): boolean | null {
  if (rotateEveryDays === null || reference === null) return null;
  return now.getTime() - reference.getTime() > rotateEveryDays * MS_PER_DAY;
}

/** The named (non-keyed) entries of a registry, sorted — the set a status read reports over. */
function reportableNames(registry: SecretRegistry): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => !entry.keyed)
    .map(([name]) => name)
    .sort();
}

/** What the secrets table knows about one name. No envelope columns are selected, so none can be returned. */
interface StoredFacts {
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What the rotations table knows about one name, aggregated. */
interface RotationFacts {
  rotationCount: number;
  lastRotatedAt: Date | null;
}

/**
 * Store metadata per name, in as few statements as D1's bound-parameter cap allows.
 *
 * The column list is the security boundary — `encryptedValue` and `iv` are on this table and are not
 * named, so a status read never pulls a ciphertext into the Worker at all.
 */
async function storedFacts(db: SecretsStatusDb, names: string[]): Promise<Map<string, StoredFacts>> {
  const found = new Map<string, StoredFacts>();
  for (const chunk of chunkByBoundParameters(names, 0)) {
    const rows = await db
      .selectFrom("pithySecretsSystemSecrets")
      .select(["name", "keyVersion", "createdAt", "updatedAt"])
      .where("name", "in", chunk)
      .execute();
    for (const row of rows) {
      // Dates decode here rather than at the shape, so every date this module handles is a `Date` and
      // the ms-epoch the column actually holds stops being something a caller could get wrong.
      found.set(row.name, {
        keyVersion: row.keyVersion,
        createdAt: SQLiteDate.parse(row.createdAt),
        updatedAt: SQLiteDate.parse(row.updatedAt),
      });
    }
  }
  return found;
}

/**
 * Rotation counts and the newest successful completion per name, in one grouped statement per chunk.
 *
 * `max(case when …)` rather than a second query: the newest *successful* completion is a different row
 * from the newest attempt, and a failed rotation must never advance the freshness of a secret it did
 * not rotate. The raw fragment names physical columns because `CamelCasePlugin` transforms identifiers
 * the builder produces and leaves raw SQL alone — the same rule `packages/auth/src/admin/users.ts`
 * follows for its `escape` clause.
 */
async function rotationFacts(db: SecretsStatusDb, names: string[]): Promise<Map<string, RotationFacts>> {
  const found = new Map<string, RotationFacts>();
  for (const chunk of chunkByBoundParameters(names, 0)) {
    const rows = await db
      .selectFrom("pithySecretsRotations")
      .select((eb) => [
        "name",
        eb.fn.countAll<number>().as("rotationCount"),
        sql<number | null>`max(case when status = 'success' then completed_at end)`.as("lastRotatedAt"),
      ])
      .where("name", "in", chunk)
      .groupBy("name")
      .execute();
    for (const row of rows) {
      found.set(row.name, {
        rotationCount: Number(row.rotationCount),
        lastRotatedAt: row.lastRotatedAt === null ? null : SQLiteDate.parse(row.lastRotatedAt),
      });
    }
  }
  return found;
}

/** Options for {@link readSecretStatus}. */
export interface SecretStatusOptions {
  /** The clock `overdue` is measured against. Injected so a freshness test does not have to wait 90 days. */
  now?: Date;
}

/**
 * Every declared secret's status, by name.
 *
 * Registry-driven rather than table-driven, because the interesting cases are the ones with no row: a
 * secret declared and never written is a real answer, and a secret that lives in Cloudflare's Secrets
 * Store has no row here by design. A table-driven read would report neither and would additionally have
 * to enumerate keyspace members to find them.
 */
export async function readSecretStatus(
  db: SecretsStatusDb,
  registry: SecretRegistry,
  options: SecretStatusOptions = {},
): Promise<SecretStatus[]> {
  const names = reportableNames(registry);
  if (names.length === 0) return [];
  const now = options.now ?? new Date();
  const [stored, rotations] = await Promise.all([storedFacts(db, names), rotationFacts(db, names)]);

  return names.map((name) => {
    // Present because `reportableNames` derived the list from this registry.
    const entry = registry[name] as SecretRegistry[string];
    const row = stored.get(name);
    const rotation = rotations.get(name);
    const lastRotatedAt = rotation?.lastRotatedAt ?? null;
    const rotateEveryDays = entry.rotateEveryDays ?? null;
    // Measured from the last successful rotation, and from first write when there has never been one:
    // a key created two years ago and never rotated is late, and reporting it as unanswerable would
    // hide exactly the secret this read exists for.
    const reference = lastRotatedAt ?? row?.createdAt ?? null;
    return SecretStatus.parse({
      name,
      backend: entry.backend,
      valueType: entry.valueType,
      rotatable: entry.rotatable,
      // Null rather than absent, and the declaration verbatim. `defineSecretRegistry` has already refused
      // a malformed one, so this is a copy of something checked at define time rather than a second
      // judgement about it — and a secret that declares nothing says so, instead of being reported as the
      // kind a client would guess.
      rotation: entry.rotation ?? null,
      keyVersion: row?.keyVersion ?? null,
      createdAt: row?.createdAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      lastRotatedAt,
      rotationCount: rotation?.rotationCount ?? 0,
      rotateEveryDays,
      overdue: overdueAgainst(reference, rotateEveryDays, now),
    });
  });
}

/**
 * One secret's rotation history, newest first, capped at `limit`.
 *
 * `id` breaks a tie on `startedAt`: two rotations recorded in the same millisecond would otherwise
 * straddle the cap in an order SQLite is free to change between reads. It is a sort key and is not
 * selected — a surrogate row id is not a fact about a secret.
 */
export async function readSecretRotations(
  db: SecretsStatusDb,
  name: string,
  limit: number,
): Promise<SecretRotationRecord[]> {
  const rows = await db
    .selectFrom("pithySecretsRotations")
    .select(["startedAt", "completedAt", "status", "trigger", "rotatedBy"])
    .where("name", "=", name)
    .orderBy("startedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => SecretRotationRecord.parse(row));
}
