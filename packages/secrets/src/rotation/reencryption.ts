// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { SecretsTables } from "../data/tables";
import { MAX_SECRETS_CACHE_TTL_SECONDS } from "../sharedSecretsStore";

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
 * key, that version's fingerprint and two timestamps per dependent, and nothing more, so the manager can ask
 * the question without learning anything about the rows the answer is about.
 *
 * ## A version key is not a value
 *
 * `update` and `pithy secrets rotate` write a fresh one-version envelope, so the version numbers start again
 * at `"1"`. A record that said only *moved under 3* would read as caught up against a new `"2"`, and the
 * manager would retire a version the dependent's rows are still sealed under. So a record names the value by
 * {@link versionFingerprint} as well, and a record whose fingerprint is not the envelope's names nothing.
 *
 * ## Every holder, not every dependent
 *
 * A dependent can be held in more than one place: two auth Workers over two databases each seal their own
 * JWKS keys under the one environment-scoped session secret. Each records under its own `holder` — the
 * database's binding name — and a retirement waits for every holder of every dependent. A holder records
 * even while the secret has one version ({@link recordSoleVersion}), so one that has served a request is known
 * before the first rotation reaches it. A holder that is gone for good keeps its row, and a retirement holds
 * for it: the version stays, which is the safe way to be wrong.
 *
 * ## Nothing moves until every reader can open what it moves to
 *
 * Workers read a secret through a per-isolate cache. An isolate that cached the envelope just before the
 * append holds no key for the new version, and would fail on a row sealed under it. So the first dependent
 * to see a version records when ({@link claimReencryption}), and the move waits {@link REENCRYPTION_SETTLE_MS}
 * from there: by then every cache filled before the append has expired.
 */

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/**
 * How long a dependent waits, from first seeing a version, before it re-seals anything under it: the
 * longest any Worker may cache a secret. A Worker's own TTL is not enough — another Worker reading the same
 * secret may be configured longer — so this is the ceiling every TTL is held under.
 */
export const REENCRYPTION_SETTLE_MS = MAX_SECRETS_CACHE_TTL_SECONDS * 1000;

/** The label every fingerprint is an HMAC of. Fixed, so two Workers compute the same fingerprint for a value. */
const FINGERPRINT_LABEL = "pithy/secrets/reencryption/v1";

/**
 * A version's fingerprint: HMAC-SHA256 of a fixed label, keyed by the value, in hex.
 *
 * The key-check value a key ceremony prints. It says whether two parties hold the same value, and nothing
 * else: finding the value from it is finding an HMAC key from one tag.
 */
export async function versionFingerprint(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(value),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(FINGERPRINT_LABEL)));
  return [...tag].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every version's fingerprint, by version key. What the manager compares a record against. */
export async function fingerprintVersions(versions: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(versions).map(async ([version, value]) => [version, await versionFingerprint(value)] as const),
  );
  return Object.fromEntries(entries);
}

/** One version of a secret, named so that a reset cannot alias it: its key and its fingerprint. */
export interface SealedVersion {
  /** The version key. */
  version: string;
  /** {@link versionFingerprint} of the value under it. */
  fingerprint: string;
}

/** An envelope's current version, as a {@link SealedVersion}. */
export async function currentSealedVersion(envelope: {
  currentVersion: string;
  versions: Readonly<Record<string, string>>;
}): Promise<SealedVersion> {
  const value = envelope.versions[envelope.currentVersion] ?? "";
  return { version: envelope.currentVersion, fingerprint: await versionFingerprint(value) };
}

/** One dependent, moved: the secret it is sealed under, its name, and the version it is now sealed under. */
export interface ReencryptionRecord extends SealedVersion {
  /** The secret, by registry name. */
  name: string;
  /** The dependent, as the entry's `overlap.reencrypt` names it. */
  dependent: string;
  /** Where it is held: the database, by its binding name. */
  holder: string;
  /** When it moved. Defaults to now. */
  now?: Date;
}

/**
 * Record that `dependent`, in `holder`, is sealed under `version` of `name`. Upserts: one row per secret,
 * dependent and holder, replaced each time it moves.
 */
export async function recordReencryption(db: SecretsDb, record: ReencryptionRecord): Promise<void> {
  const at = SQLiteDate.encode(record.now ?? new Date());
  await db
    .insertInto("pithySecretsReencryptions")
    .values({
      name: record.name,
      dependent: record.dependent,
      holder: record.holder,
      version: record.version,
      fingerprint: record.fingerprint,
      observedAt: at,
      movedAt: at,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["name", "dependent", "holder"])
        .doUpdateSet({ version: record.version, fingerprint: record.fingerprint, movedAt: at }),
    )
    .execute();
}

/** Where a dependent stands against the version it sees as current. */
export type ReencryptionClaim =
  /** Already sealed under it. Nothing to do. */
  | { state: "moved" }
  /** Seen, and not yet safe to move under: some reader may still hold no key for it until `until`. */
  | { state: "settling"; until: Date }
  /** Safe to move under now. */
  | { state: "due" };

/** What {@link claimReencryption} needs. */
export interface ReencryptionClaimInput {
  /** The secret, by registry name. */
  name: string;
  /** The dependent, as the entry's `overlap.reencrypt` names it. */
  dependent: string;
  /** Where it is held: the database, by its binding name. */
  holder: string;
  /** The version the dependent sees as current. */
  sealed: SealedVersion;
  /** The clock. Defaults to now. */
  now?: Date;
}

/**
 * Where `dependent` stands against `sealed`, recording the first sight of a version.
 *
 * A row for another version, or for the same key under another value, is replaced by one that says this
 * version was seen now and has not moved — which also tells the manager the dependent is behind. A row for
 * this version is left as it is, so a second isolate does not restart the clock.
 */
export async function claimReencryption(db: SecretsDb, input: ReencryptionClaimInput): Promise<ReencryptionClaim> {
  const now = input.now ?? new Date();
  const row = await db
    .selectFrom("pithySecretsReencryptions")
    .select(["version", "fingerprint", "observedAt", "movedAt"])
    .where("name", "=", input.name)
    .where("dependent", "=", input.dependent)
    .where("holder", "=", input.holder)
    .executeTakeFirst();
  if (row !== undefined && row.version === input.sealed.version && row.fingerprint === input.sealed.fingerprint) {
    if (row.movedAt !== null && row.movedAt !== undefined) return { state: "moved" };
    const until = new Date(SQLiteDate.parse(row.observedAt).getTime() + REENCRYPTION_SETTLE_MS);
    return now.getTime() >= until.getTime() ? { state: "due" } : { state: "settling", until };
  }
  const at = SQLiteDate.encode(now);
  await db
    .insertInto("pithySecretsReencryptions")
    .values({
      name: input.name,
      dependent: input.dependent,
      holder: input.holder,
      version: input.sealed.version,
      fingerprint: input.sealed.fingerprint,
      observedAt: at,
      movedAt: null,
    })
    .onConflict((conflict) =>
      conflict.columns(["name", "dependent", "holder"]).doUpdateSet({
        version: input.sealed.version,
        fingerprint: input.sealed.fingerprint,
        observedAt: at,
        movedAt: null,
      }),
    )
    .execute();
  return { state: "settling", until: new Date(now.getTime() + REENCRYPTION_SETTLE_MS) };
}

/**
 * Record a holder while the secret has one version: sealed under it, since there is nothing else to be sealed
 * under. Writes only when the holder's row says otherwise, so an isolate's first request costs one read.
 *
 * This is how the manager learns a holder exists before the first rotation does. Without it, a database whose
 * Worker served no request between a rotation and its retirement would never have recorded, and the version
 * its keys are sealed under would be retired over them.
 */
export async function recordSoleVersion(
  db: SecretsDb,
  input: Omit<ReencryptionClaimInput, "now"> & { now?: Date },
): Promise<void> {
  const row = await db
    .selectFrom("pithySecretsReencryptions")
    .select(["version", "fingerprint", "movedAt"])
    .where("name", "=", input.name)
    .where("dependent", "=", input.dependent)
    .where("holder", "=", input.holder)
    .executeTakeFirst();
  const recorded =
    row !== undefined &&
    row.version === input.sealed.version &&
    row.fingerprint === input.sealed.fingerprint &&
    row.movedAt !== null &&
    row.movedAt !== undefined;
  if (recorded) return;
  await recordReencryption(db, {
    name: input.name,
    dependent: input.dependent,
    holder: input.holder,
    ...input.sealed,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/**
 * The dependents of `name` not yet re-encrypted under `version` — the ones a retirement still waits for.
 *
 * `fingerprints` is the envelope as it stands now, by version key ({@link fingerprintVersions}). A holder is
 * caught up only when its row says it moved, names a version the envelope still holds under the same value,
 * and that version is `version` or later — compared as the integers they spell, so `"10"` is past `"9"`. A
 * dependent is caught up when it has a row and every holder's row is. Anything else is pending: no row, a row
 * still settling, or a row from before a reset. A dependent with no row at all answers as itself; one that
 * is behind in one holder answers as `<dependent>/<holder>`, so the trail says which database to look at.
 */
export async function pendingReencryptions(
  db: SecretsDb,
  name: string,
  dependents: readonly string[],
  version: string,
  fingerprints: Readonly<Record<string, string>>,
): Promise<string[]> {
  if (dependents.length === 0) return [];
  const rows = await db
    .selectFrom("pithySecretsReencryptions")
    .select(["dependent", "holder", "version", "fingerprint", "movedAt"])
    .where("name", "=", name)
    .where("dependent", "in", [...dependents])
    .orderBy("holder")
    .execute();
  const behind = (row: (typeof rows)[number]): boolean => {
    if (row.movedAt === null || row.movedAt === undefined) return true;
    if (fingerprints[row.version] !== row.fingerprint) return true;
    const at = Number(row.version);
    return !Number.isInteger(at) || at < Number(version);
  };
  return dependents.flatMap((dependent) => {
    const held = rows.filter((row) => row.dependent === dependent);
    if (held.length === 0) return [dependent];
    return held.filter(behind).map((row) => `${dependent}/${row.holder}`);
  });
}
