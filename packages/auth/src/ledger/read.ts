// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { sql } from "kysely";
import type { AdminPage } from "../admin/users";
import type { AuthDatabase } from "../data/tables";
import { VerificationOutcome, type VerificationState, VerificationType } from "../data/verificationOutcome";
import type { VerificationTypeCounts } from "../http/responses";

/**
 * Reading the verification ledger (#829): what `GET {auth}/admin/verifications` answers.
 *
 * Two reads over one window of issue times: the counts by type and state, and the rows themselves, paged. The
 * state is computed at read time — an unused row becomes expired the moment its expiry passes, with nothing
 * written — so both reads take the same `now`, and a row counted as pending is listed as pending.
 */

/** How far back a window reaches when the caller names no start. */
export const DEFAULT_WINDOW_DAYS = 30;

/** A window of issue times: `since` inclusive, `until` exclusive. */
export interface VerificationWindow {
  since: Date;
  until: Date;
}

/**
 * The window a read covers. `until` defaults to now and `since` to 30 days before it; a window that ends where it
 * starts, or before, is refused rather than answered with nothing, because an empty answer would read as "no
 * sign-ins".
 */
export function resolveVerificationWindow(input: { since?: Date; until?: Date }, now: Date): VerificationWindow {
  const until = input.until ?? now;
  const since = input.since ?? new Date(until.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (since.getTime() >= until.getTime()) {
    throw new ValidationError({
      message: "The window must start before it ends.",
      detail: `since ${since.toISOString()} is not before until ${until.toISOString()}`,
    });
  }
  return { since, until };
}

/**
 * The counts by type and state over a window: one aggregate, grouped by type, and every type answered — a type
 * nothing was issued for reads as zeros rather than going missing, so a reader never has to tell "none" from
 * "not reported".
 */
export async function verificationCounts(
  db: AuthDatabase,
  window: VerificationWindow,
  now: Date,
): Promise<VerificationTypeCounts[]> {
  const at = SQLiteDate.encode(now);
  const rows = await db
    .selectFrom("pithyAuthVerificationOutcomes")
    .select((eb) => [
      "type",
      eb.fn.countAll<number>().as("issued"),
      sql<number>`sum(case when ${eb.ref("usedAt")} is not null then 1 else 0 end)`.as("used"),
      sql<number>`sum(case when ${eb.ref("usedAt")} is null and ${eb.ref("expiresAt")} <= ${at} then 1 else 0 end)`.as(
        "expired",
      ),
    ])
    .where("issuedAt", ">=", SQLiteDate.encode(window.since))
    .where("issuedAt", "<", SQLiteDate.encode(window.until))
    .groupBy("type")
    .execute();
  return VerificationType.options.map((type) => {
    const row = rows.find((candidate) => candidate.type === type);
    const issued = Number(row?.issued ?? 0);
    const used = Number(row?.used ?? 0);
    const expired = Number(row?.expired ?? 0);
    return { type, issued, used, expired, pending: issued - used - expired };
  });
}

/** What the row listing filters on and where it resumes. */
export interface ListVerificationOutcomesOptions {
  window: VerificationWindow;
  /** Only this type. */
  type?: VerificationType | undefined;
  /** Only rows in this state at `now`. */
  state?: VerificationState | undefined;
  /** The moment `state` is judged at — the same `now` the counts took. */
  now: Date;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * The window's rows, newest issue first, paged by keyset on `(issuedAt, id)` — the index the migration built for
 * exactly this. A malformed cursor is a first page, as everywhere in the kit.
 */
export async function listVerificationOutcomes(
  db: AuthDatabase,
  options: ListVerificationOutcomesOptions,
): Promise<AdminPage<VerificationOutcome>> {
  const limit = pageLimit(options.limit);
  const at = SQLiteDate.encode(options.now);
  let query = db
    .selectFrom("pithyAuthVerificationOutcomes")
    .selectAll()
    .where("issuedAt", ">=", SQLiteDate.encode(options.window.since))
    .where("issuedAt", "<", SQLiteDate.encode(options.window.until))
    .orderBy("issuedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);
  if (options.type) query = query.where("type", "=", options.type);
  if (options.state === "used") query = query.where("usedAt", "is not", null);
  if (options.state === "expired") query = query.where("usedAt", "is", null).where("expiresAt", "<=", at);
  if (options.state === "pending") query = query.where("usedAt", "is", null).where("expiresAt", ">", at);

  const cursor = decodeCursor(options.cursor);
  const sort = cursor ? Number(cursor.sort) : Number.NaN;
  const id = cursor ? Number(cursor.id) : Number.NaN;
  // A cursor whose halves are not both numbers came from some other listing. It reads as a first page.
  if (Number.isFinite(sort) && Number.isFinite(id)) {
    query = query.where((eb) =>
      eb.or([eb("issuedAt", "<", sort), eb.and([eb("issuedAt", "=", sort), eb("id", "<", id)])]),
    );
  }

  const rows = await query.execute();
  return toPage(
    rows.map((row) => VerificationOutcome.parse(row)),
    limit,
    (row) => ({ sort: row.issuedAt.getTime(), id: row.id }),
  );
}
