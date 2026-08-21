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
import type { CarriesNoValue } from "../valueBearing";

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
 *    either shape makes this module fail to typecheck. The type behind it is `../valueBearing.ts`,
 *    moved out of this file so that `http/responses.ts` — a module a browser imports — can make the
 *    same promise without acquiring this file's Kysely reader and the D1 layer behind it (#419).
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
 * One row of a batch read as the read found it: its facts, or that the row is there and would not decode.
 *
 * **The state rides on the value (`#384`, `#387`).** Every read in this file is a batch — a chunk of names
 * against one statement — so a row that throws is a row that costs every other name in the chunk. Holding
 * the outcome on the value means a caller cannot reach the facts without narrowing, and forgetting the
 * unreadable case is a compile error rather than a silent empty.
 *
 * **Absent is a third fact and it is not in this union.** A name with no row is simply not a key in the
 * map, which is what `SecretStatus`'s nulls already mean: declared and never written, or living in
 * Cloudflare's Secrets Store. *Missing* and *malformed* have different remedies — write it, versus repair
 * the row — and folding either into the other reports a stored secret as unprovisioned.
 *
 * `unreadable` carries nothing, for the reason `#384` gives: there is nothing safe to put on it. What the
 * decode rejected is a column value from a row about a secret, and the name it is filed under is already
 * the key.
 */
type Decoded<T> = { state: "readable"; facts: T } | { state: "unreadable" };

/**
 * Store metadata per name, in as few statements as D1's bound-parameter cap allows.
 *
 * The column list is the security boundary — `encryptedValue` and `iv` are on this table and are not
 * named, so a status read never pulls a ciphertext into the Worker at all.
 *
 * **The date decode is per row since `#387`.** It sat inside `for (const row of rows)` unguarded, which is
 * easy to miss because it does not read like parsing a row — it reads like converting a field. One corrupt
 * ms-epoch threw out of the loop and lost the whole chunk, so every secret in it reported nothing on
 * account of one.
 */
async function storedFacts(db: SecretsStatusDb, names: string[]): Promise<Map<string, Decoded<StoredFacts>>> {
  const found = new Map<string, Decoded<StoredFacts>>();
  for (const chunk of chunkByBoundParameters(names, 0)) {
    const rows = await db
      .selectFrom("pithySecretsSystemSecrets")
      .select(["name", "keyVersion", "createdAt", "updatedAt"])
      .where("name", "in", chunk)
      .execute();
    for (const row of rows) {
      // Dates decode here rather than at the shape, so every date this module handles is a `Date` and
      // the ms-epoch the column actually holds stops being something a caller could get wrong.
      //
      // The `catch` takes no binding. A `SQLiteDate` rejection carries the offending column value as the
      // issue's `input`, and these rows sit beside `error_message` and `metadata_snapshot` — free text
      // written where a value was in scope. Nothing derived from the failure may travel, and nothing can,
      // because there is nothing in scope to attach.
      try {
        found.set(row.name, {
          state: "readable",
          facts: {
            keyVersion: row.keyVersion,
            createdAt: SQLiteDate.parse(row.createdAt),
            updatedAt: SQLiteDate.parse(row.updatedAt),
          },
        });
      } catch {
        found.set(row.name, { state: "unreadable" });
      }
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
 *
 * **The third site of `#387`'s shape, and it was not in the issue.** `#387` named `storedFacts` and
 * `readSecretRotations`; this loop decodes `lastRotatedAt` exactly as `storedFacts` decodes its two, from
 * the same aggregate over the same table, and was unguarded for the same reason — it reads like a field
 * conversion. Worth stating plainly: the sweep that produced the issue looked at this file and did not
 * see it, which is the argument for asking the question again rather than for trusting a list.
 */
async function rotationFacts(db: SecretsStatusDb, names: string[]): Promise<Map<string, Decoded<RotationFacts>>> {
  const found = new Map<string, Decoded<RotationFacts>>();
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
      // Null is not a failure here and must not become one: it is the aggregate saying this secret has
      // never rotated successfully, which is the fact `SecretStatus.lastRotatedAt` is documented to carry.
      // Only a non-null value that will not decode is unreadable.
      try {
        found.set(row.name, {
          state: "readable",
          facts: {
            rotationCount: Number(row.rotationCount),
            lastRotatedAt: row.lastRotatedAt === null ? null : SQLiteDate.parse(row.lastRotatedAt),
          },
        });
      } catch {
        found.set(row.name, { state: "unreadable" });
      }
    }
  }
  return found;
}

/**
 * One declared secret's place in a status read: its status, or that a row about it would not decode.
 *
 * **A bad row is held against its own name (`#170`, `#384`).** The read is registry-driven and every name
 * in it is one an operator declared, so the whole list still comes back and the one that could not be read
 * says so under the name it belongs to. `#350` already made a throw here survivable — the capability
 * reports `unavailable` and its siblings are fine — and that is a different thing from correct: the
 * information was still lost for every secret because of one row, and the manifest could not say which.
 *
 * The name is safe to carry, and that was checked rather than assumed. It comes from
 * `reportableNames(registry)`, so it is a registry literal an operator wrote. Keyed entries are excluded
 * from this read, so no `<keyspace>/<key>` — a stored name embedding a tenant identifier from caller input
 * — can appear here. That is the trap `#384` hit and had to correct.
 */
export type SecretStatusEntry =
  | {
      /** The row decoded, and this secret's status is below. */
      state: "readable";
      /** Its declaration, its store metadata, and whether it is late. */
      status: SecretStatus;
    }
  | {
      /** A row this secret's status is built from did not decode. Its facts are not knowable from here. */
      state: "unreadable";
      /** Which secret. A registry name, never a stored one. */
      name: string;
    };

/**
 * One entry of a secret's rotation history: the record, or that the row would not decode.
 *
 * Unlike {@link SecretStatusEntry} this carries no name, and that is not an oversight. Every row in the
 * page is the *same* secret's — the name is the argument the read was called with, and it is echoed once
 * by the caller. What distinguishes a row here is its position in a history, which the array preserves: a
 * bad row costs its own entry and the rows around it still resolve, in order.
 *
 * Nothing else rides on the unreadable member. `startedAt` is the field most likely to be the one that
 * would not decode, so a "when" would be exactly the thing that is missing.
 */
export type SecretRotationEntry =
  | {
      /** The row decoded. */
      state: "readable";
      /** One rotation attempt, in metadata only. */
      record: SecretRotationRecord;
    }
  | {
      /** The row did not decode, and holds its own place in the history rather than emptying it. */
      state: "unreadable";
    };

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
): Promise<SecretStatusEntry[]> {
  const names = reportableNames(registry);
  if (names.length === 0) return [];
  const now = options.now ?? new Date();
  const [stored, rotations] = await Promise.all([storedFacts(db, names), rotationFacts(db, names)]);

  return names.map((name): SecretStatusEntry => {
    // Present because `reportableNames` derived the list from this registry.
    const entry = registry[name] as SecretRegistry[string];
    const storedEntry = stored.get(name);
    const rotationEntry = rotations.get(name);
    // Either table having an undecodable row about this secret makes its status unknowable, and both are
    // held the same way. **Absent is not that**: `undefined` here is a name with no row, which is the
    // answer this read exists to give — declared and never written, or stored in Cloudflare's Secrets
    // Store. Missing and malformed stay separate before either becomes an error.
    if (storedEntry?.state === "unreadable" || rotationEntry?.state === "unreadable") {
      return { state: "unreadable", name };
    }
    const row = storedEntry?.facts;
    const rotation = rotationEntry?.facts;
    const lastRotatedAt = rotation?.lastRotatedAt ?? null;
    const rotateEveryDays = entry.rotateEveryDays ?? null;
    // Measured from the last successful rotation, and from first write when there has never been one:
    // a key created two years ago and never rotated is late, and reporting it as unanswerable would
    // hide exactly the secret this read exists for.
    const reference = lastRotatedAt ?? row?.createdAt ?? null;
    // **Left unguarded on purpose, and this is the note saying so.** `#387` was filed naming this parse as
    // a third site and the claim was withdrawn on checking. It runs over registry declarations
    // `defineSecretRegistry` already refused at define time, plus facts normalised above — so a throw here
    // is an author error in a registry, not a bad row in a database. Guarding it would convert a defect
    // that should be loud into a secret quietly reporting as unreadable.
    const status = SecretStatus.parse({
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
    return { state: "readable", status };
  });
}

/**
 * One secret's rotation history, newest first, capped at `limit`.
 *
 * `id` breaks a tie on `startedAt`: two rotations recorded in the same millisecond would otherwise
 * straddle the cap in an order SQLite is free to change between reads. It is a sort key and is not
 * selected — a surrogate row id is not a fact about a secret.
 *
 * **Guarded per row since `#387`.** This ended `rows.map((row) => SecretRotationRecord.parse(row))`, so one
 * malformed row threw out of the whole read — and the read is a *history*, per secret, so a single bad row
 * cost every rotation record the caller asked for. A history is the surface an incident review reads, and
 * losing all of it because the oldest row has a bad timestamp is the failure mode least worth having.
 */
export async function readSecretRotations(
  db: SecretsStatusDb,
  name: string,
  limit: number,
): Promise<SecretRotationEntry[]> {
  const rows = await db
    .selectFrom("pithySecretsRotations")
    .select(["startedAt", "completedAt", "status", "trigger", "rotatedBy"])
    .where("name", "=", name)
    .orderBy("startedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  return rows.map((row): SecretRotationEntry => {
    // The `catch` takes no binding. A `ZodError` from this parse carries the offending column value as its
    // issue `input`, and the row it came from is one whose neighbouring columns are `error_message` and
    // `metadata_snapshot` — free text written at a failure site. Nothing derived from the rejection may
    // travel, and with nothing in scope there is nothing that could.
    try {
      return { state: "readable", record: SecretRotationRecord.parse(row) };
    } catch {
      return { state: "unreadable" };
    }
  });
}
