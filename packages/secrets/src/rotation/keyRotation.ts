// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { decryptValue, type EncryptionConfig, encryptValue } from "../crypto/envelope";
import type { SecretsTables } from "../data/tables";
import { MASTER_KEY_BINDING } from "../env/masterKeyBinding";
import { SecretCryptoError } from "../error/errors";

type SecretsDb = Kysely<DatabaseSchema<SecretsTables>>;

/** Generate a fresh AES-256 key, base64-encoded. The encryption-key version axis (not value version). */
export async function generateKeyB64(): Promise<string> {
  // generateKey is typed `CryptoKey | CryptoKeyPair` and exportKey("raw") `ArrayBuffer | JsonWebKey`;
  // for a symmetric AES-GCM key the runtime returns the CryptoKey / ArrayBuffer branch.
  const key = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const exported = new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
  let binary = "";
  for (const byte of exported) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A staged key: the config to write, the version it was filed under, and the instant of the pass.
 *
 * Three values and not one, because the version and the instant are what the rest of the pass is *about* —
 * the read-back asserts the version landed, the promotion moves the pointer to it and stamps the instant,
 * and the prune floor is the pointer this staged envelope still carries. Deriving any of them a second time
 * is how two derivations come to disagree.
 *
 * The instant is an ISO-8601 string rather than a `Date` because a Workflow journal round-trips JSON: a
 * `Date` comes back an object on the first pass and a string on the resume.
 */
export interface StagedKey {
  /** The config to write: every prior key, plus the new one, under the **unchanged** `currentVersion`. */
  staged: EncryptionConfig;
  /** The version key the new key was filed under — `"N+1"`, as a stringified integer. */
  nextVersion: string;
  /** The pass instant, stamped as `lastRotatedAt` by {@link promoteStagedKey} and nowhere else. */
  at: string;
}

/**
 * The highest version a config names — the pointer and every key it holds.
 *
 * A fresh key is allocated *after* this, never after `currentVersion + 1`. A pass that staged a key and
 * failed to promote it leaves `{ currentVersion: N, versions: { N, N+1 } }` behind, with rows possibly
 * already sealed under N+1; allocating from the pointer would hand the next pass that same number and
 * overwrite live key material with fresh bytes — an outage manufactured by the repair. Allocating from the
 * maximum is monotone: a version is written once and never rewritten.
 *
 * **The pointer counts even when the key set does not hold it.** That state is a reportable finding rather
 * than a crash (D9), and the repair for it is a rotation — so this answers, and answers high enough that
 * the promotion which follows moves the pointer forwards.
 *
 * A version that is not an integer is refused rather than sorted lexically: `"10" < "9"` as text, and the
 * consequence of getting it wrong is a key set whose newest key is not the one the pointer names. The
 * refusal names nothing it read. This is precisely the malformed-config branch, where a base64 key may be
 * sitting in the key position, and a `detail` that echoed the offending entry would carry it into a log.
 */
export function highestVersion(config: EncryptionConfig): number {
  let highest = Number.NEGATIVE_INFINITY;
  for (const version of [config.currentVersion, ...Object.keys(config.versions)]) {
    const value = Number(version);
    if (!Number.isInteger(value)) {
      throw new SecretCryptoError({
        message: "The master key configuration holds a version that is not a number.",
        action: `Inspect this environment's ${MASTER_KEY_BINDING} entry: every version key is a stringified integer.`,
        detail: "master-key config: a version key is not a stringified integer",
      });
    }
    if (value > highest) highest = value;
  }
  return highest;
}

/**
 * Stage a fresh key as the next version **without moving the pointer**.
 *
 * The two things it does not do are the whole of it (`#647`). It does not advance `currentVersion`, so
 * nothing starts encrypting under a key that may not be readable back yet. And it does not advance
 * `lastRotatedAt`, because that field is the cadence clock `isRotationDue` reads: a staged write that
 * touched it would let a pass which aborted before promoting report itself rotated, and the cron would not
 * ask again for a month.
 *
 * What the write *does* publish is the key itself, which is what makes the rest of the pass safe. Once the
 * binding holds key N+1, a row sealed under N+1 opens — `decryptValue` resolves `versions[row.keyVersion]`
 * and never consults the pointer — so an interruption anywhere after the confirmed staged write leaves a
 * store that still reads, however far the re-encryption got.
 *
 * `now` is required rather than defaulted. It is the pass instant, and a Workflow body re-executes from the
 * top on every resume: a clock read in here would answer differently on each attempt and date the key it
 * rotated by the resume. The caller journals it in a step and hands it in.
 */
export async function stageNextKey(config: EncryptionConfig, now: Date): Promise<StagedKey> {
  const nextVersion = String(highestVersion(config) + 1);
  return {
    nextVersion,
    at: now.toISOString(),
    staged: {
      currentVersion: config.currentVersion,
      versions: { ...config.versions, [nextVersion]: await generateKeyB64() },
      lastRotatedAt: config.lastRotatedAt,
    },
  };
}

/**
 * Promote a staged key to current — in memory, over the staged set, as a second value rather than an edit.
 *
 * **It refuses unless the key is there.** Handing the *staged* envelope to `reencryptBatch` selects the rows
 * that are not on version N — none, because every row is — and re-encrypts nothing, in a pass that returns
 * two zeroes and reads exactly like a store that was already rotated. So the only envelope naming N+1 is one
 * built from a set that holds N+1, and `keyRotation.workers.test.ts` holds the other half: the staged
 * envelope is proven to be the no-op, at the site that would spring it.
 *
 * The pass instant lands here and only here. The promotion is the moment a rotation happened.
 */
export function promoteStagedKey(staged: StagedKey): EncryptionConfig {
  const key = staged.staged.versions[staged.nextVersion];
  if (key === undefined || key.length === 0) {
    throw new SecretCryptoError({
      message: "The rotated master key is not in the key set it would be promoted over.",
      action: "Nothing to run. The previous key stays current and the next scheduled pass starts over.",
      detail: `promote: version ${staged.nextVersion} is absent or empty in the staged key set`,
    });
  }
  return {
    currentVersion: staged.nextVersion,
    versions: staged.staged.versions,
    lastRotatedAt: staged.at,
  };
}

/**
 * What a healthy key set holds at its widest: the superseded key, the current one, and the one being staged.
 *
 * A pass over `{ N }` stages `N+1` and keeps both, because the prune is deferred a generation. The pass after
 * it stages `N+2` — three, for the length of that pass — and then retires everything below `N+1`, back to two.
 * Three is therefore the peak of a store where nothing is wrong, and nothing narrower is a bug.
 */
const HEALTHY_KEY_SET_PEAK = 3;

/**
 * How many abandoned stages a store may accumulate before the ceiling refuses.
 *
 * A pass that publishes a key and then aborts leaves that key behind — correctly, since rows may already be
 * sealed under it — so a run of failures widens the set without anything being broken. Five is generous for a
 * monthly cadence: it is five months of aborted passes, and `lastAtRestRotation` has been reporting `failed`
 * on the manifest for every one of them.
 */
const ABANDONED_STAGE_HEADROOM = 5;

/**
 * The most key versions a rotation will let the set hold. Derived, never chosen: {@link HEALTHY_KEY_SET_PEAK}
 * plus {@link ABANDONED_STAGE_HEADROOM}.
 *
 * **It bounds the one failure that fails toward safety, which is why it needs bounding (`#647`).** A row that
 * will not decrypt keeps `failed > 0` forever, the prune gate refuses while any row sits on a retiring
 * version, and so retirement never happens again — while the pass closes `success` and the set gains a key
 * every cadence. Nothing breaks. That is the problem: an unbounded, silent accumulation, every entry of which
 * is a key that should have been destroyed months ago and is instead still live in the account's Secrets
 * Store. Rotation exists to close a key's exposure window, and a set that never retires is a rotation that
 * has stopped delivering the only thing it is for.
 *
 * **The remedy is a refusal, and never a retirement.** Deleting a key a row might still need is the one
 * irreversible move on this path — a corrupt ciphertext is not a missing key, and a row that fails today may
 * be recoverable tomorrow, but not after its key is gone. So at the ceiling the pass stops minting instead:
 * the store keeps working, every key stays, and the ledger row closes `failed`, which `lastAtRestRotation`
 * publishes as `failed` and `standingOf` grades attention. A finding somebody sees, in place of a number
 * nobody reads.
 */
export const MAX_KEY_SET_SIZE = HEALTHY_KEY_SET_PEAK + ABANDONED_STAGE_HEADROOM;

/**
 * The versions a prune may drop: everything below the pointer this pass **superseded**.
 *
 * **The floor is the superseded pointer, and never the key set (D10).** Inferring it — "the highest version
 * below the current one" — collapses the deferral to zero on the state `#647` exists to produce. A pass that
 * staged key 2 and aborted leaves `{ currentVersion: "1", versions: { 1, 2 } }` with every row on key 1; the
 * next pass promotes to 3, and an inferred floor calls 2 the predecessor and retires key 1 in the very pass
 * that superseded it. The pass knows which pointer it replaced. It says so.
 *
 * Deferred a full generation, deliberately: the version a pass just superseded is exactly the one a row that
 * failed to re-encrypt is still sitting on, and the pass that created the successor is the worst moment to
 * find that out. A key survives the pass that replaced it and goes in the next one.
 *
 * Two things are never retired whatever floor arrives. A version at or above `currentVersion` — the current
 * key is the store, and a key above the pointer belongs to an earlier stage that rows may already hold. And
 * nothing at all when the floor is not an integer: `NaN` compares false, which is the right answer, and
 * saying so beats leaving it to a comparison nobody reads twice.
 *
 * Retiring is safe only once no row references a retired version, which {@link countOnKeyVersions} asks.
 * That count is point-in-time and there is no barrier behind it — a request-path write landing between the
 * count and the prune, on a retiring version, is lost. Reaching that window takes a writer isolate holding a
 * config two full cadence intervals old, which is why the generation of deferral is the thing making the
 * gate sound rather than the gate making the prune sound.
 */
export function retiredVersions(promoted: EncryptionConfig, supersededVersion: string): string[] {
  const floor = Number(supersededVersion);
  const current = Number(promoted.currentVersion);
  // **Both sides fail closed, and the pointer is the one that matters (#647 review).** This used to clamp
  // the floor to the pointer only when the pointer parsed — `Number.isInteger(current) ? min : floor` —
  // so a config whose `currentVersion` was unreadable skipped the clamp entirely and retired against the
  // bare floor. That is the one branch the clamp exists for: a pointer nobody can read is a pointer nobody
  // can prove a key sits below, and the safe answer to "which keys may I delete" is always none. The
  // floor's own guard is belt and braces over `NaN < ceiling` already being false; the pointer's is not.
  if (!Number.isInteger(floor) || !Number.isInteger(current)) return [];
  const ceiling = Math.min(floor, current);
  return Object.keys(promoted.versions)
    .filter((version) => Number(version) < ceiling)
    .sort((left, right) => Number(left) - Number(right));
}

/**
 * Drop every retired version from a config, or `null` when there is nothing to retire — which is the
 * ordinary answer for the pass that just created a successor.
 */
export function pruneRetiredKeys(promoted: EncryptionConfig, supersededVersion: string): EncryptionConfig | null {
  const retired = new Set(retiredVersions(promoted, supersededVersion));
  if (retired.size === 0) return null;
  const versions: Record<string, string> = {};
  for (const [version, key] of Object.entries(promoted.versions)) {
    if (!retired.has(version)) versions[version] = key;
  }
  return { currentVersion: promoted.currentVersion, versions, lastRotatedAt: promoted.lastRotatedAt };
}

/**
 * One re-encryption batch: how many rows rolled to the current key, and how many would not.
 *
 * **Two counts, and no third field carrying why (`#386`).** This shape used to hold
 * `errors: Array<{ id, error }>`, filled from a bound `cause.message` in the loop below. Nothing read it
 * — `runAtRestKeyRotation` sums `failed` and never looks — so it disclosed nothing, and that is exactly
 * the state worth removing rather than the state worth keeping. The rule is that a catch here takes no
 * binding; a field waiting to be surfaced is how "let us report why the rotation failed" becomes a
 * disclosure in one reasonable-looking commit, and every string that could have landed in it came from
 * decrypting or encrypting a secret.
 *
 * What a run needs is whether progress is being made, which `rotated` answers, and whether rows are stuck,
 * which `failed` answers. Which rows, and why, is a question for the throw site — and it does not throw.
 */
export interface ReencryptResult {
  rotated: number;
  failed: number;
}

/**
 * Re-encrypt one batch of `pithy_secrets_system_secrets` rows that are not on the current key
 * version: decrypt under the row's old key, re-encrypt under the current key, update in place. The
 * plaintext (the `{ currentVersion, versions }` value envelope) is opaque here — only the
 * encryption key changes. Each row is independent; a failure is counted, never thrown, so one bad row
 * cannot abort the batch — and never described, so nothing derived from it can travel.
 */
export async function reencryptBatch(
  db: SecretsDb,
  config: EncryptionConfig,
  batchSize = 100,
): Promise<ReencryptResult> {
  const result: ReencryptResult = { rotated: 0, failed: 0 };
  const rows = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select(["id", "name", "encryptedValue", "iv", "keyVersion"])
    .where("keyVersion", "!=", Number(config.currentVersion))
    .limit(batchSize)
    .execute();
  if (rows.length === 0) return result;

  for (const row of rows) {
    try {
      // Same name in and out: re-encryption changes the key, never the bound context.
      const plaintext = await decryptValue(config, row.name, row);
      const reencrypted = await encryptValue(config, row.name, plaintext);
      await db
        .updateTable("pithySecretsSystemSecrets")
        .set({
          encryptedValue: reencrypted.encryptedValue,
          iv: reencrypted.iv,
          keyVersion: reencrypted.keyVersion,
          updatedAt: SQLiteDate.encode(new Date()),
        })
        .where("id", "=", row.id)
        .execute();
      result.rotated++;
    } catch {
      // No binding, and that is the point rather than a tidiness (`#386`). A decrypt failure's own text
      // names the key version it tried; an encrypt failure's names what it was sealing. Neither may reach
      // a log, a response, or a stored column, and a catch with nothing in scope makes that impossible to
      // get wrong later rather than merely absent today.
      result.failed++;
    }
  }
  return result;
}

const MS_PER_DAY = 86_400_000;

/**
 * Whether an at-rest rotation is due: the configured interval has elapsed since `lastRotatedAt`.
 * The cron fires on a fixed schedule and calls this so it only rotates when due, not every tick.
 *
 * The interval is refused before it is compared, and the failure it prevents is the quiet kind. The cron
 * computes it as `Number(env.ROTATION_INTERVAL_DAYS ?? 30)` over a var an operator hand-edits in
 * `manager/wrangler.jsonc`, so `"30 days"`, `"thirty"` or `"30d"` all yield `NaN` — and `now >= NaN` is false.
 * At-rest rotation of the master key then never becomes due, on every tick, forever, with no error and no line
 * in the log. `@pithy-sh/email`'s scheduler shipped exactly this bug against `SCHEDULER_BATCH_SIZE` and refuses
 * it the same way; the secrets manager is the same template pattern and never got the treatment.
 *
 * A zero or negative interval is refused too, for the opposite reason: it makes a rotation due on every tick,
 * which is a Workflow started every minute against the key that decrypts the store. There is no safe number to
 * clamp a typo to, so it is named and refused.
 */
export function isRotationDue(lastRotatedAt: string, intervalDays: number, now: Date = new Date()): boolean {
  if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
    throw new InternalError({
      message: "The secrets manager is misconfigured.",
      action: "Set ROTATION_INTERVAL_DAYS to a positive number of days, or unset it for the default of 30.",
      detail: `ROTATION_INTERVAL_DAYS resolved to ${String(intervalDays)}; it must be a finite number greater than zero, or at-rest rotation silently never comes due.`,
    });
  }
  return now.getTime() >= new Date(lastRotatedAt).getTime() + intervalDays * MS_PER_DAY;
}

/**
 * Count rows sealed under any of `versions` — the gate on a prune.
 *
 * It asks about the versions that are **about to be deleted**, not about the versions that are merely not
 * current. Those were the same question while a prune dropped everything but the pointer, and they stopped
 * being the same question when the prune began deferring a generation: a row on the previous key is
 * perfectly healthy now, and only a row on a key that is leaving is a reason to stop.
 *
 * An empty list is zero without a query — `where … in ()` is not something to make Kysely answer, and the
 * empty retirement set is the ordinary case for the pass that rotated. A version that is not an integer is
 * refused: `Number("two")` is `NaN`, a `NaN` in this list under-counts, and an under-count here passes the
 * gate and deletes a key rows are still sealed under.
 */
export async function countOnKeyVersions(db: SecretsDb, versions: readonly string[]): Promise<number> {
  if (versions.length === 0) return 0;
  const numbered = versions.map((version) => Number(version));
  if (!numbered.every((version) => Number.isInteger(version))) {
    throw new SecretCryptoError({
      message: "The master key configuration holds a version that is not a number.",
      action: `Inspect this environment's ${MASTER_KEY_BINDING} entry: every version key is a stringified integer.`,
      detail: "prune gate: a version to count rows on is not a stringified integer",
    });
  }
  const row = await db
    .selectFrom("pithySecretsSystemSecrets")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("keyVersion", "in", numbered)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
