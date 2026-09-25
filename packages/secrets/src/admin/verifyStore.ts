// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **Does every stored secret still open — and if not, is it the key set or the ciphertext?**
 *
 * The sibling of `admin/status.ts`, and the difference between them is the whole of this file.
 * `status` reports that a row *decoded*: it selects `key_version`, `created_at`, `updated_at` and never
 * touches an envelope, so a row whose master key has gone missing reads there exactly like a healthy one.
 * This reports that a row *decrypts*, which is the only question `#647`'s failure mode answers to — a
 * rotation that moved `currentVersion` and never landed the key it points at leaves a store that every
 * metadata read calls healthy and every write fails against.
 *
 * ## What leaves this function, exhaustively
 *
 * Integers, and a discriminant. Counts of rows, counts per key version, the key versions the resolved
 * config holds, and the versions rows reference that it does not. No name — not a registry name and
 * emphatically not a keyspace member's stored name, which embeds a tenant identifier. No plaintext. No
 * key material. And **no decrypt failure's own text**: {@link storedRowOpens} answers a boolean over a
 * `catch` that binds nothing, so there is no such text in scope here to fold in by accident (#386).
 *
 * {@link STORE_VERIFICATION_CARRIES_NO_VALUE} is the compile-time half, matching the tripwires in
 * `admin/status.ts` and `http/responses.ts`: widening either shape with a value-bearing field fails the
 * build rather than a review.
 *
 * ## The master key that will not resolve is a finding, not a crash (D15)
 *
 * The master-key read throws when `SECRETS_ENCRYPTION_KEYS` is absent, is not JSON, or does not
 * parse. That is precisely what a misaddressed envelope write leaves behind — the state this whole issue
 * exists for — and letting it throw out of here reports the end state as *the manager could not be
 * reached*, which is the code a cron retries forever. So it is caught and named: `keySet: "unreadable"`,
 * a row count and a key-version histogram (both of which are plain columns and need no key at all), and
 * nothing claimed about what would have opened.
 *
 * ## Two guards against reporting a healthy store as broken
 *
 * A missing version is the one finding whose remedy touches the value an operator can least afford to
 * hand-edit, so it is the one that is confirmed twice before it is reported:
 *
 * - **The config is re-read.** The at-rest rotation writes rows under `keyVersion: N+1` and propagation
 *   to a binding is not instant, so a sweep holding a snapshot from before the key write sees rows on a
 *   version its config does not hold. A real missing version survives a second read; a propagation race
 *   does not.
 * - **A live pass is reported.** `rotationInProgress` says an at-rest rotation is running right now, and
 *   the CLI says to re-run after it finishes rather than to restore a key.
 */

import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { EncryptionConfig } from "../crypto/envelope";
import { AT_REST_ROTATION_NAME } from "../data/secretRotations";
import { type SecretsTables, secretsTables } from "../data/tables";
import type { SecretsStoreEnv } from "../env/bindings";
import { SecretCryptoError } from "../error/errors";
import { bindingConfigReader } from "../manager/configReader";
import { RotationTracker } from "../store/rotationTracker";
import { storedRowOpens } from "../store/systemSecretsStore";
import type { CarriesNoValue } from "../valueBearing";

/** The Kysely instance the sweep runs against — typed over the secrets tables, CamelCasePlugin installed. */
export type SecretsVerifyDb = Kysely<DatabaseSchema<SecretsTables>>;

/** How many rows one statement of the sweep reads. Small enough to stay well inside a Workflow step. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * How many rows are sealed under one master-key version.
 *
 * The histogram is the fact an operator acts on during an at-rest rotation: it says how far the
 * re-encryption has got, and after a rotation it says whether anything is still sealed under a key that
 * is about to be pruned. A count, never a name — which rows those are is not answerable from here and
 * must not be.
 */
export const KeyVersionRows = z
  .object({
    keyVersion: z
      .number()
      .int()
      .describe("The master-key version the rows were sealed under, as the `key_version` column holds it."),
    rows: z.number().int().nonnegative().describe("How many stored rows carry that version."),
  })
  .describe("One bar of the key-version histogram: a master-key version, and how many rows are sealed under it.");
export type KeyVersionRows = z.output<typeof KeyVersionRows>;

/**
 * The verification when the master key resolved and every row was actually opened.
 *
 * `missingVersions` and `currentVersionHeld` are two halves of one defect and neither implies the other.
 * A row on a version the config dropped is *data already written* that can no longer be read; a
 * `currentVersion` the key set does not hold is *every future write* failing while every existing row
 * still opens. A rotation that got as far as moving the pointer and no further produces the second alone,
 * which is why reporting only the first was blind to the state step 4 exists to prevent.
 */
const VerifiedStore = z
  .object({
    keySet: z.literal("resolved").describe("The master-key config resolved, so every row was opened or tried."),
    rows: z.number().int().nonnegative().describe("How many rows the sweep read, across every page."),
    readable: z.number().int().nonnegative().describe("How many of them decrypted and decoded."),
    unreadable: z
      .number()
      .int()
      .nonnegative()
      .describe("How many did not. A count only — what a decrypt failure said never leaves the Worker."),
    keyVersions: z
      .array(KeyVersionRows)
      .describe("Rows per master-key version, ascending — how far a re-encryption has got, and what still holds."),
    heldVersions: z
      .array(z.number().int())
      .describe("Every master-key version the resolved config holds a key for, ascending."),
    currentVersion: z
      .number()
      .int()
      .nullable()
      .describe(
        "The config's active pointer as an integer, or null when it is not a stringified integer — which is itself a finding rather than a reason to lose the whole read.",
      ),
    currentVersionHeld: z
      .boolean()
      .describe(
        "Whether the config holds a key under its own `currentVersion`. False means every existing row may still open while every new write fails.",
      ),
    missingVersions: z
      .array(z.number().int())
      .describe(
        "Versions stored rows reference that the config no longer holds, ascending. Confirmed against a second read of the binding before it is reported.",
      ),
    rotationInProgress: z
      .boolean()
      .describe(
        "Whether an at-rest key rotation is running right now. While it is, a missing version may be a propagation race rather than a fault.",
      ),
  })
  .describe("A store verification that ran: counts, the key-version histogram, and the key set it ran against.");

/**
 * The verification when `SECRETS_ENCRYPTION_KEYS` would not resolve — the #647 end state, named (D15).
 *
 * Nothing was opened, so nothing claims to have been. The row count and the histogram are still here
 * because both are plain columns: they are what tells an operator whether the environment holds one row
 * or ten thousand, which is the difference between a store nobody has written to and an outage.
 */
const UnreadableKeySet = z
  .object({
    keySet: z
      .literal("unreadable")
      .describe("The master-key config would not resolve: no binding, not JSON, or not an EncryptionConfig."),
    rows: z.number().int().nonnegative().describe("How many rows are stored. Read from metadata, opened by nothing."),
    keyVersions: z
      .array(KeyVersionRows)
      .describe("Rows per master-key version, ascending — the `key_version` column, which needs no key to read."),
    rotationInProgress: z
      .boolean()
      .describe("Whether an at-rest key rotation is running right now, read from the ledger rather than the store."),
  })
  .describe("A store verification that could not run, because the master key it needs would not resolve.");

/**
 * One environment's store, verified — or the statement that it could not be.
 *
 * A discriminated union rather than a flag on one object, because the two answers have no fields in
 * common that mean the same thing: `readable: 0` on a store nothing could open would be indistinguishable
 * from `readable: 0` on an empty store, and a caller reading the second as the first reports an outage as
 * a clean bill of health. Narrowing is the point.
 */
export const StoreVerification = z
  .discriminatedUnion("keySet", [VerifiedStore, UnreadableKeySet])
  .describe("What one environment's manager found in its store: counts and key versions, and never a value.");
export type StoreVerification = z.output<typeof StoreVerification>;

/**
 * The compile-time half of the constraint, matching `admin/status.ts`'s and `http/responses.ts`'s.
 *
 * Each member of the union is named separately on purpose: `keyof (A | B)` is the *intersection* of their
 * keys, so a value-bearing field added to one member alone would slip past a single check over the union.
 */
export const STORE_VERIFICATION_CARRIES_NO_VALUE: CarriesNoValue<z.output<typeof VerifiedStore>> &
  CarriesNoValue<z.output<typeof UnreadableKeySet>> &
  CarriesNoValue<KeyVersionRows> = true;

/** One page of the sweep: the envelope columns a decrypt needs, and nothing that is not one. */
interface StoredRow {
  name: string;
  encryptedValue: string;
  iv: string;
  keyVersion: number;
}

/** What one full pass over the table found. `counts` is version → rows; the caller sorts it. */
interface SweepTotals {
  rows: number;
  readable: number;
  unreadable: number;
  counts: Map<number, number>;
}

/**
 * Walk every row by name cursor, opening each one when there is a key set to open it with.
 *
 * Cursored rather than offset-paged: a store being written to during a long sweep shifts every offset,
 * so an offset walk skips rows across a page boundary and double-counts others. `name` is unique and the
 * order is stable, so `where name > last` reads each row exactly once whatever else is happening.
 *
 * `config` is null when the master key would not resolve. Then the row is counted and its version binned
 * — both of which are columns — and nothing is attempted, so no count claims an outcome that was never
 * reached.
 */
async function sweepRows(
  db: SecretsVerifyDb,
  config: EncryptionConfig | null,
  batchSize: number,
): Promise<SweepTotals> {
  const totals: SweepTotals = { rows: 0, readable: 0, unreadable: 0, counts: new Map() };
  let after = "";
  for (;;) {
    const page: StoredRow[] = await db
      .selectFrom("pithySecretsSystemSecrets")
      .select(["name", "encryptedValue", "iv", "keyVersion"])
      .where("name", ">", after)
      .orderBy("name")
      .limit(batchSize)
      .execute();
    if (page.length === 0) return totals;
    for (const row of page) {
      totals.rows += 1;
      totals.counts.set(row.keyVersion, (totals.counts.get(row.keyVersion) ?? 0) + 1);
      if (config === null) continue;
      if (await storedRowOpens(config, row)) totals.readable += 1;
      else totals.unreadable += 1;
    }
    // The last name of a full page is the next cursor. A short page is the last one.
    if (page.length < batchSize) return totals;
    after = page[page.length - 1]?.name ?? after;
  }
}

/** The histogram, ascending by version — one order whoever reads it. */
function histogram(counts: Map<number, number>): KeyVersionRows[] {
  return [...counts.entries()]
    .map(([keyVersion, rows]) => ({ keyVersion, rows }))
    .sort((a, b) => a.keyVersion - b.keyVersion);
}

/**
 * Every version the config holds a **usable** key for, ascending. Non-integer keys are not versions and are
 * skipped.
 *
 * **Present is not held, and the rotation already knew that (#647 review).** `holdsKey` in
 * `rotation/atRestKeyRotation.ts` requires `key.length > 0` because a blank key decrypts nothing, and this
 * checked only for the property existing. A config carrying `versions: { "3": "" }` therefore reported
 * version 3 as held and kept it out of `missingVersions` — the command under-reporting the exact defect it
 * exists to find. One definition of held, in both places.
 */
function heldVersions(config: EncryptionConfig): number[] {
  return Object.entries(config.versions)
    .filter(([key, value]) => /^\d+$/.test(key) && value.length > 0)
    .map(([key]) => Number(key))
    .sort((a, b) => a - b);
}

/**
 * The config's pointer as an integer, or null.
 *
 * `Number` alone is the wrong parse for this field twice over: `Number("")` is `0`, a perfectly ordinary
 * version number, so an empty pointer would report as version zero; and `Number(" 3 ")` is `3`, so a
 * pointer nothing can look up would report as one that can. The column is documented as a stringified
 * integer, so that is exactly what is accepted.
 */
function pointerVersion(config: EncryptionConfig): number | null {
  return /^\d+$/.test(config.currentVersion) ? Number(config.currentVersion) : null;
}

/** Versions rows reference that this config does not hold, ascending. */
function missingAgainst(counts: Map<number, number>, held: readonly number[]): number[] {
  return [...counts.keys()].filter((version) => !held.includes(version)).sort((a, b) => a - b);
}

/**
 * Resolve the master key, or answer that it would not resolve.
 *
 * The caught error is narrowed and dropped, never reported: `SecretCryptoError`'s `detail` names which of
 * the three ways the binding failed, and that is an operator fact the *CLI* composes from the discriminant
 * rather than a string this read forwards. Anything that is not a crypto fault is re-thrown — a Workflow
 * that swallowed an unrelated bug and reported "the key will not resolve" would send an operator to edit
 * the one value whose corruption is unrecoverable.
 */
async function resolveOrNull(env: SecretsStoreEnv): Promise<EncryptionConfig | null> {
  try {
    // **Read through `bindingConfigReader`, not `resolveEncryptionConfig` (#647 review).** The latter wraps
    // every failure of `.get()` into `SecretCryptoError`, so a momentary Secrets Store fault was
    // indistinguishable here from a master key that will not decode. This reader is the one place that
    // splits them, and it already did: a binding that would not *answer* is `core/upstream_failed`, and only
    // a payload that will not *parse* is `secrets/crypto_failed`.
    //
    // The difference is what an operator is told. A transient blip used to render as `keySet: "unreadable"`,
    // verdict `key-unreadable`, exit 5 — documented as the one state no retry ever fixes, over the sentence
    // "Nothing in this store can be read until it does." That points somebody at the single value whose
    // wrong edit is unrecoverable, on a store that is fine. An upstream failure now propagates as the
    // unreachable fault it is, which the caller already reports as retryable.
    return await bindingConfigReader(env).read();
  } catch (error) {
    if (error instanceof SecretCryptoError) return null;
    throw error;
  }
}

/** Options the Workflow forwards. Only the page size, and only so a test can cross a page boundary cheaply. */
export interface VerifyStoredSecretsOptions {
  /** Rows per statement. Defaults to 100. */
  batchSize?: number;
}

/**
 * Verify one environment's store: open every row, and report what opened.
 *
 * Writes nothing. Not a row, not a ledger entry, not a `last verified` stamp — a detector that writes is
 * a detector that can itself be the fault, and this one runs against the store whose writes are already
 * suspect.
 */
export async function verifyStoredSecrets(
  env: SecretsStoreEnv,
  options: VerifyStoredSecretsOptions = {},
): Promise<StoreVerification> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const db = createDatabase(env.SECRETS, secretsTables);
  // Read from the ledger rather than inferred from the store: a pass that has minted a key and not yet
  // re-encrypted anything is invisible in the histogram and is exactly when a missing version is a race.
  const rotationInProgress = (await RotationTracker.fromD1(env.SECRETS).liveRotation(AT_REST_ROTATION_NAME)) !== null;

  const config = await resolveOrNull(env);
  if (config === null) {
    const totals = await sweepRows(db, null, batchSize);
    return { keySet: "unreadable", rows: totals.rows, keyVersions: histogram(totals.counts), rotationInProgress };
  }

  const totals = await sweepRows(db, config, batchSize);
  let effective = config;
  let missingVersions = missingAgainst(totals.counts, heldVersions(config));
  if (missingVersions.length > 0) {
    // The second read. A key written during this sweep is held by now; a key that is genuinely gone is
    // still gone. The remedy for the second is to restore a version by hand, so it is worth one binding
    // read to be sure the first is not being reported as it.
    const fresh = await resolveOrNull(env);
    if (fresh !== null) {
      effective = fresh;
      missingVersions = missingAgainst(totals.counts, heldVersions(fresh));
    }
  }

  const held = heldVersions(effective);
  return {
    keySet: "resolved",
    rows: totals.rows,
    readable: totals.readable,
    unreadable: totals.unreadable,
    keyVersions: histogram(totals.counts),
    heldVersions: held,
    currentVersion: pointerVersion(effective),
    // The raw key, not the parsed one: a config whose pointer is not an integer still either holds a key
    // under that exact string or does not, and conflating the two questions loses one of them.
    // Non-empty, not merely present — the same definition `heldVersions` and the rotation's `holdsKey` use.
    currentVersionHeld: (effective.versions[effective.currentVersion] ?? "").length > 0,
    missingVersions,
    rotationInProgress,
  };
}
