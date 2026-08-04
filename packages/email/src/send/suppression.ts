// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { EmailSuppression } from "../data/emailSuppression";
import type { SuppressionReason } from "../data/enums";
import type { EmailSuppressionDatabase } from "../data/tables";

/**
 * The suppression list: addresses that must not be emailed, fed by hard bounces, complaints, and
 * unsubscribes. The send path checks it before every send and skips a match. Addresses are normalized
 * (trimmed, lowercased) so a check and a write always agree on the key.
 *
 * The list is also the one thing in this capability a management client both reads and writes, and it
 * is **global** — one database shared by every environment, so a row here stops mail from staging and
 * production alike. That is why reading it, adding to it, and removing from it are three separate
 * control-plane scopes rather than one.
 */

/** Normalize an address for the suppression key — trim and lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether an address is currently suppressed (a non-expired row exists). */
export async function isSuppressed(db: EmailSuppressionDatabase, email: string, now: Date): Promise<boolean> {
  const row = await db
    .selectFrom("pithyEmailSuppressions")
    .select(["expiresAt"])
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  if (!row) return false;
  if (row.expiresAt === null || row.expiresAt === undefined) return true;
  return SQLiteDate.parse(row.expiresAt).getTime() > now.getTime();
}

/** Add (or refresh) a suppression for an address. Idempotent on the unique `email` column. */
export async function suppress(
  db: EmailSuppressionDatabase,
  input: {
    email: string;
    reason: SuppressionReason;
    jobId?: string | null;
    environment?: string | null;
    detail?: string | null;
    expiresAt?: Date | null;
  },
  now: Date,
): Promise<void> {
  const email = normalizeEmail(input.email);
  const jobId = input.jobId ?? null;
  const environment = input.environment ?? null;
  const detail = input.detail ?? null;
  const expiresAt = input.expiresAt ? SQLiteDate.encode(input.expiresAt) : null;
  await db
    .insertInto("pithyEmailSuppressions")
    .values({ email, reason: input.reason, jobId, environment, detail, expiresAt, createdAt: SQLiteDate.encode(now) })
    .onConflict((oc) => oc.column("email").doUpdateSet({ reason: input.reason, jobId, environment, detail, expiresAt }))
    .execute();
}

/**
 * Remove a suppression. Returns whether a row was actually removed.
 *
 * The boolean matters: an operator unblocking an address that was never blocked, and one unblocking an
 * address that was, are two different events and the audit trail should not record them as the same
 * one. It also keeps the route idempotent — asking twice is not an error, it is simply the second one
 * finding nothing to do.
 *
 * There is no soft delete. A suppression is a "do not send" flag, and a lifted flag that stays in the
 * table is one bad query away from still being enforced.
 */
export async function unsuppress(db: EmailSuppressionDatabase, email: string): Promise<boolean> {
  const result = await db
    .deleteFrom("pithyEmailSuppressions")
    .where("email", "=", normalizeEmail(email))
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

/** What the suppression list filters and pages by. */
export interface SuppressionListFilter {
  /** One reason, or every reason when absent. */
  reason?: SuppressionReason;
  /** Look one address up exactly, rather than paging the list. */
  email?: string;
  /** The previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped into range. */
  limit?: number;
}

/** One page of the suppression list. */
export interface SuppressionPage {
  /** The suppressed addresses, most recently blocked first. */
  items: EmailSuppression[];
  /** Where the next page starts, or null at the end of the list. */
  nextCursor: string | null;
}

/**
 * A cursor this table can resume from.
 *
 * Both halves must be numbers here — `createdAt` is a ms-epoch and `id` is an autoincrement integer —
 * and anything else is treated exactly as a malformed cursor is. A string compared against an integer
 * column in SQLite does not fail; it orders by something nobody meant, which is worse.
 */
function suppressionCursor(raw: string | undefined): { sort: number; id: number } | undefined {
  const cursor: PageCursor | undefined = decodeCursor(raw);
  if (!cursor || typeof cursor.sort !== "number" || typeof cursor.id !== "number") return undefined;
  return { sort: cursor.sort, id: cursor.id };
}

/**
 * One page of the suppression list, most recently blocked first.
 *
 * Keyset, never offset — the same rule every list in this repo follows, and it applies here even though
 * the table is quieter than the job log: a hard bounce arriving mid-scroll would otherwise skip a row
 * for the person reading it.
 */
export async function listSuppressions(
  db: EmailSuppressionDatabase,
  filter: SuppressionListFilter,
): Promise<SuppressionPage> {
  const limit = pageLimit(filter.limit);
  const after = suppressionCursor(filter.cursor);

  let query = db
    .selectFrom("pithyEmailSuppressions")
    .selectAll()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  if (filter.reason) query = query.where("reason", "=", filter.reason);
  // Exact equality on the normalized key, never a prefix or a LIKE: a lookup that also matched
  // neighbours would be a way to enumerate the list one query at a time while looking like a question
  // about a single address.
  if (filter.email) query = query.where("email", "=", normalizeEmail(filter.email));
  if (after) {
    query = query.where((eb) =>
      eb.or([eb("createdAt", "<", after.sort), eb.and([eb("createdAt", "=", after.sort), eb("id", "<", after.id)])]),
    );
  }

  const rows = await query.execute();
  const items = rows.map((row) => EmailSuppression.parse(row));
  return toPage(items, limit, (row) => ({ sort: row.createdAt.getTime(), id: row.id }));
}
