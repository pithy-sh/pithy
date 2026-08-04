// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { EmailJob } from "../data/emailJob";
import type { EmailJobStatus } from "../data/enums";
import type { EmailDatabase } from "../data/tables";

/**
 * Reading the send log — the query behind the two `email:jobs:read` routes.
 *
 * **Keyset pagination, never offset.** `pithy_email_jobs` is written to on every single send, which
 * makes it the worst possible table to page with `OFFSET`: a row inserted at the head while somebody is
 * on page two pushes one row from page one down, so they see it twice and miss another by luck. The
 * cursor names the last row's `(createdAt, id)` position, so the next page starts exactly where the
 * previous ended whatever arrived in between. The helper is core's — one implementation, one decode,
 * one definition of what a malformed cursor means.
 *
 * `createdAt` is the sort key rather than `sendAt`: a scheduled job's `sendAt` is a *future* time that a
 * retry then moves, so ordering on it would shuffle rows around under a reader for reasons that have
 * nothing to do with when anything happened. `createdAt` never moves.
 *
 * Rows are decoded through `EmailJob.parse` before they leave this module, so callers get Dates and
 * booleans rather than ms-epochs and `0|1` — and a corrupt row fails here rather than three layers up.
 */

/** What the list filters and pages by. */
export interface JobListFilter {
  /** One lifecycle state, or every state when absent. */
  status?: EmailJobStatus;
  /** The previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped into range. */
  limit?: number;
}

/** One page of the send log. */
export interface JobPage {
  /** The jobs, newest first. */
  items: EmailJob[];
  /** Where the next page starts, or null at the end of the list. */
  nextCursor: string | null;
}

/**
 * A cursor this table can actually resume from.
 *
 * `PageCursor.sort` is a union because Better Auth stores ISO text where Pithy's own tables store
 * ms-epoch numbers, and comparing a string against an integer column in SQLite silently orders by
 * something nobody meant. Jobs store a number, so anything else is treated exactly as a malformed
 * cursor is: undefined, and the caller gets a first page.
 */
function jobCursor(raw: string | undefined): { sort: number; id: string } | undefined {
  const cursor: PageCursor | undefined = decodeCursor(raw);
  if (!cursor || typeof cursor.sort !== "number") return undefined;
  return { sort: cursor.sort, id: String(cursor.id) };
}

/** One page of jobs, newest first, optionally filtered to one status. */
export async function listJobs(db: EmailDatabase, filter: JobListFilter): Promise<JobPage> {
  const limit = pageLimit(filter.limit);
  const after = jobCursor(filter.cursor);

  let query = db
    .selectFrom("pithyEmailJobs")
    .selectAll()
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    // One more than asked for, so "is there another page" is answerable without a count query — which
    // on a table holding every email a project ever sent is the difference between a page and a scan.
    .limit(limit + 1);

  if (filter.status) query = query.where("status", "=", filter.status);
  if (after) {
    query = query.where((eb) =>
      eb.or([eb("createdAt", "<", after.sort), eb.and([eb("createdAt", "=", after.sort), eb("id", "<", after.id)])]),
    );
  }

  const rows = await query.execute();
  const jobs = rows.map((row) => EmailJob.parse(row));
  return toPage(jobs, limit, (job) => ({ sort: job.createdAt.getTime(), id: job.id }));
}

/** One job by id, or undefined. The caller decides what a miss means. */
export async function getJob(db: EmailDatabase, jobId: string): Promise<EmailJob | undefined> {
  const row = await db.selectFrom("pithyEmailJobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  return row ? EmailJob.parse(row) : undefined;
}
