// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import type { StorageObjectRow, StorageObjectStatus } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase } from "../data/tables";
import { StorageQuotaExceededError } from "../error/errors";

/**
 * Per-owner byte quotas.
 *
 * **Quota is checked when an upload *starts*, and the sum counts `pending` rows alongside `stored`
 * ones.** That is the whole design, and it is not an optimization.
 *
 * Counting only completed uploads would make the check meaningless under concurrency: ten clients
 * that each declare 1 GiB against a 1 GiB quota all read a used total of zero, all pass, and all
 * upload. Nothing in that sequence is a bug in any single request — the check is simply measuring the
 * wrong thing. Making the client declare its size up front, and having the `pending` row *reserve*
 * those bytes the moment it is written, turns the quota into something a concurrent burst cannot
 * walk past: the second init reads the first's reservation.
 *
 * **The reservation only holds if the sum and the insert are one statement.** A `SELECT sum(size)`
 * followed by a separate `INSERT` reproduces the very race it was meant to close, one round trip
 * later: ten concurrent inits all read a used total that none of them has yet contributed to, all
 * pass, and all insert. D1 has no interactive transactions, so a `BEGIN`/`COMMIT` wrapper is not
 * available — {@link insertReservingQuota} is the mechanism instead. It writes the pending row with a
 * conditional `INSERT … SELECT … WHERE`, so the sum is evaluated *inside* the write, and a row that
 * would breach the limit simply does not appear.
 *
 * {@link assertWithinQuota} survives as the cheap pre-check a handler runs before it creates anything
 * that would need cleaning up. It is a courtesy, not the enforcement.
 *
 * **Completion settles the same way it reserved.** A part URL carries no signed `Content-Length`, so
 * an owner may PUT more than they declared, and the overshoot has to be re-asserted when the row turns
 * `stored`. That re-assertion is {@link updateSettlingQuota} — a conditional `UPDATE`, the same shape
 * as the conditional `INSERT` — because two completions racing on a plain check both read a total
 * neither has yet contributed and both pass. The rule is one rule: every write that changes what an
 * owner holds evaluates the sum inside itself.
 *
 * The reservation is not free — an abandoned upload holds bytes it never stored. That is what
 * `pendingTtlSeconds` and the orphan sweep are for: a `pending` row past its TTL is aborted and
 * dropped, returning its reservation. Over-counting briefly and reclaiming is the right way round;
 * under-counting has no recovery.
 *
 * A `null` limit is unlimited and skips the query entirely. A `null` owner (a system object) has no
 * quota — there is no principal to bill it to.
 */

/** What a quota check needs. */
export interface QuotaCheck {
  /** The storage database. */
  db: StorageDatabase;
  /** The owner the bytes are billed to. Null is a system object, which no quota applies to. */
  ownerId: string | null;
  /** The configured per-owner ceiling in bytes. Null is unlimited. */
  limitBytes: number | null;
  /** The bytes this upload declares — what the pending row is about to reserve. */
  additionalBytes: number;
}

/** A quota check plus the row whose insertion *is* the reservation. */
export interface QuotaReservation extends QuotaCheck {
  /** The row to write, already through `StorageObject.encode` — the SQLite shape, never the app one. */
  record: StorageObjectRow;
}

/** A quota check plus the row whose update *is* the settlement. */
export interface QuotaSettlement extends QuotaCheck {
  /**
   * The whole row to write, already through `StorageObject.encode`. Its `id` is what the update
   * targets — the settlement rewrites one known row rather than a set.
   */
  record: StorageObjectRow;
}

/**
 * The statuses that bill an owner: a `pending` row reserves its declared bytes and a `stored` one
 * holds real ones. `failed` bills nothing.
 *
 * Exported because the orphan sweep asks the same question of the same rows — a key is *claimed* if
 * and only if a row bills for it — and the two predicates drifting apart is what let a `failed` row
 * shield its R2 object from collection while counting toward nobody's quota
 * (`workflows/sweep.ts`).
 */
export const QUOTA_COUNTED_STATUSES: readonly StorageObjectStatus[] = ["pending", "stored"];

/**
 * Bytes an owner currently holds: every `pending` reservation plus every `stored` object. `failed`
 * rows are excluded — they hold no bytes and reserve nothing.
 */
export async function usedBytes(db: StorageDatabase, ownerId: string): Promise<number> {
  const row = await db
    .selectFrom(STORAGE_OBJECTS_TABLE)
    // `size` is nullable (a caller may not declare one), and SUM over no rows is NULL — coalesce both
    // to zero here rather than letting a null leak into arithmetic.
    .select(sql<number>`coalesce(sum(size), 0)`.as("used"))
    .where("ownerId", "=", ownerId)
    .where("status", "in", [...QUOTA_COUNTED_STATUSES])
    .executeTakeFirst();
  return Number(row?.used ?? 0);
}

/** A size a caller declared has to be a real byte count. Zero is fine; negative is a client bug. */
function assertDeclaredSize(additionalBytes: number): void {
  if (additionalBytes >= 0) return;
  throw new StorageQuotaExceededError({
    message: "An upload needs a size.",
    action: "Declare the file's byte count when you start the upload.",
    detail: `negative declared size ${additionalBytes}`,
  });
}

/**
 * Throw `storage/quota_exceeded` when this upload would put the owner over their limit. The
 * comparison is `used + additional > limit`, so an upload landing exactly on the limit is allowed —
 * a quota is a ceiling you may reach, not one you must stay under.
 *
 * **This is a pre-check, not the reservation.** It reads a total nothing holds still, so between it
 * and any later write a concurrent init can have taken the room. Use it to refuse an obviously
 * oversized upload *before* opening an R2 multipart upload there would then be nothing to clean up
 * for, and let {@link insertReservingQuota} be the boundary that actually decides.
 */
export async function assertWithinQuota(check: QuotaCheck): Promise<void> {
  if (check.limitBytes === null || check.ownerId === null) return;
  assertDeclaredSize(check.additionalBytes);

  const used = await usedBytes(check.db, check.ownerId);
  if (used + check.additionalBytes > check.limitBytes) {
    throw new StorageQuotaExceededError({
      detail: `owner would hold ${used + check.additionalBytes} bytes against a limit of ${check.limitBytes}`,
    });
  }
}

/**
 * Insert a storage row **only if** it fits inside the owner's quota, and throw
 * `storage/quota_exceeded` when it does not.
 *
 * The sum and the write are one statement — `INSERT … SELECT <values> WHERE (SELECT sum(size) …) <=
 * limit - additional` — because two statements cannot be made to hold a reservation without a
 * transaction, and D1 has none to offer. SQLite evaluates the sub-select while it holds the write
 * lock, so a burst of concurrent inits is serialized by the database itself: each one sees every
 * reservation that landed before it, and the first that would breach the limit inserts nothing.
 *
 * `RETURNING id` is how "inserted nothing" is read back. Zero rows is not an error to SQLite — the
 * `WHERE` simply matched nothing — so the absence of a returned row *is* the quota answer.
 */
export async function insertReservingQuota(reservation: QuotaReservation): Promise<void> {
  const { db, ownerId, limitBytes, additionalBytes, record } = reservation;
  if (limitBytes === null || ownerId === null) {
    await db.insertInto(STORAGE_OBJECTS_TABLE).values(record).execute();
    return;
  }
  assertDeclaredSize(additionalBytes);

  // The column list is read off the encoded record rather than spelled out, so a new column on
  // `StorageObject` is carried here without an edit — and stays camelCase, which `CamelCasePlugin`
  // snake-cases on the way out.
  const columns = Object.keys(record) as (keyof StorageObjectRow)[];
  const values = db
    .selectNoFrom((eb) => columns.map((column) => eb.val(record[column]).as(column)))
    // `used <= limit - additional` rather than `used + additional <= limit`: same integers, but the
    // owner's total stays alone on the left where the sub-select can be compared against a constant.
    .where((eb) =>
      eb(
        eb
          .selectFrom(STORAGE_OBJECTS_TABLE)
          .select(sql<number>`coalesce(sum(size), 0)`.as("used"))
          .where("ownerId", "=", ownerId)
          .where("status", "in", [...QUOTA_COUNTED_STATUSES]),
        "<=",
        limitBytes - additionalBytes,
      ),
    );

  const inserted = await db
    .insertInto(STORAGE_OBJECTS_TABLE)
    .columns(columns)
    .expression(values)
    .returning("id")
    .executeTakeFirst();

  if (!inserted) {
    throw new StorageQuotaExceededError({
      detail: `reservation of ${additionalBytes} bytes lost against a limit of ${limitBytes}`,
    });
  }
}

/**
 * Rewrite one row **only if** the bytes it newly claims still fit inside the owner's quota, and throw
 * `storage/quota_exceeded` when they do not.
 *
 * This is {@link insertReservingQuota}'s other half, and it exists for the identical reason. A
 * completion measures what R2 actually holds against what the pending row reserved, and the difference
 * is bytes the owner has not been granted yet. Settling that difference with a separate
 * {@link assertWithinQuota} would put the enforcement back where it never worked: two completions
 * racing both read a total neither has yet contributed to, both pass, and the owner ends over the
 * limit — the same defect the conditional insert was written to close, one lifecycle stage later.
 *
 * `additionalBytes` is the **overshoot**, not the object's size. The row being updated is still
 * `pending`, so the sub-select in the `WHERE` already counts its reservation: SQLite evaluates the
 * condition against the pre-update table. Passing the full size would bill the reservation twice.
 *
 * `RETURNING id` reads back whether the row moved. Zero rows updated is not an error to SQLite — the
 * `WHERE` simply matched nothing — so the absence of a returned row *is* the quota answer.
 */
export async function updateSettlingQuota(settlement: QuotaSettlement): Promise<void> {
  const { db, ownerId, limitBytes, additionalBytes, record } = settlement;
  if (limitBytes === null || ownerId === null) {
    await db.updateTable(STORAGE_OBJECTS_TABLE).set(record).where("id", "=", record.id).execute();
    return;
  }
  assertDeclaredSize(additionalBytes);

  const updated = await db
    .updateTable(STORAGE_OBJECTS_TABLE)
    .set(record)
    .where("id", "=", record.id)
    // Same comparison as the reservation — `used <= limit - additional` — so both halves of the
    // lifecycle answer the same arithmetic and one of them cannot drift.
    .where((eb) =>
      eb(
        eb
          .selectFrom(STORAGE_OBJECTS_TABLE)
          .select(sql<number>`coalesce(sum(size), 0)`.as("used"))
          .where("ownerId", "=", ownerId)
          .where("status", "in", [...QUOTA_COUNTED_STATUSES]),
        "<=",
        limitBytes - additionalBytes,
      ),
    )
    .returning("id")
    .executeTakeFirst();

  if (!updated) {
    throw new StorageQuotaExceededError({
      detail: `settlement of ${additionalBytes} further bytes lost against a limit of ${limitBytes}`,
    });
  }
}
