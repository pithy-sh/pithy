// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import { EmailJob } from "../data/emailJob";
import type { EmailJobStatus } from "../data/enums";
import type { EmailDatabase } from "../data/tables";

/**
 * Reading the send log: the queries behind the two `email:jobs:read` routes, and `sentSince` below.
 *
 * The two are different questions and deliberately not one function. The routes serve an operator
 * walking the log — every job, newest first, filtered by status, paged, and gated by a control-plane
 * scope. `sentSince` answers a single question for the adopter's own code, in their own Worker, about a
 * message they are about to send: has this template already gone to this person. It is not exposed over
 * HTTP, because nothing calls it over HTTP — see its own note.
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

/**
 * ## `sentSince` — has this template already gone to this person
 *
 * The narrow read, for the caller deciding whether to send. A transactional notice that must not repeat,
 * and must be *corrected* if the thing it announced stops being true, cannot be decided from a flag of
 * the caller's own: a `cancellationNoticeSentAt` column is a second answer to a question this table
 * already holds the first of, and the two disagree the first time a send fails after the flag is
 * written. `pithy_email_jobs` is the record; this is the read over it, so nobody has to define its shape
 * a second time in their own repository.
 *
 * ## Four columns, and every other one is a deliberate no
 *
 * `SentSummary` is `EmailJob.pick(…)`, so the columns it carries are the columns it selects and a
 * projection cannot leak one it never loaded. What is not on it:
 *
 * - **`toAddress`.** The caller passed the address in; handing it back means a read answering a question
 *   about one person returns a copy of them in every row, and any log of the result is an address list.
 * - **`payload`.** The sign-in link and the OTP. `view.ts` argues this at length and the argument is the
 *   same here, except that this reader is reachable from ordinary application code rather than only from
 *   a scoped credential, which makes it stronger rather than weaker.
 * - **`subject`.** Rendered content, and the temptation is specific: it is the only per-row string that
 *   distinguishes two messages sharing a template, so a caller needing that discrimination would match
 *   on it. That match breaks on a copy edit, silently, in the direction of sending again. Discriminating
 *   two notices is the enqueue side's problem — see the report on #354 — not something to solve by
 *   exporting a rendered string to be string-matched.
 * - **`messageId`, `error`, `bounceCode`.** The provider's own words. A provider error routinely embeds
 *   the recipient, which is why the list view carries `failed` rather than the text.
 *
 * `status` rather than a boolean, because the statuses are the answer: a `failed` or `suppressed` row is
 * an email nobody read, and a reader that collapsed the log to "yes" would treat it as one they did.
 *
 * ## Bounded, and it says when the bound bit
 *
 * The log is append-only and unbounded by nature, so the read is capped — and a cap that silently
 * truncates is the failure mode, not the bound. `truncated` says the cap was reached, the same word
 * `@pithy-sh/auth`'s bounded sub-lists use. A caller counting rows must read it; a caller asking only
 * "did anything go out" may ignore it, because a truncated page is still a non-empty one.
 */

/**
 * One job as the send-decision reader sees it: the handle, the outcome, and the two instants.
 *
 * Derived from `EmailJob` with `.pick()` rather than restated, so the codecs and the field descriptions
 * come from the one table definition and a column added to the row does not silently appear here.
 * Re-described because `.pick()` builds a new schema and the top-level description does not follow it.
 */
export const SentSummary = EmailJob.pick({ id: true, status: true, createdAt: true, sentAt: true }).describe(
  "One previously enqueued message, as the caller deciding whether to send another one sees it. No recipient, no subject, no payload, no provider text — the id is the handle into the full record for anyone holding the scope to read it.",
);
export type SentSummary = z.output<typeof SentSummary>;

/** What `sentSince` asks. Every field is required but the bound, and the bound is the only one clamped. */
export interface SentFilter {
  /** The recipient. Matched under `normalizeAddress`, the same rule the row was keyed under. */
  to: string;
  /** The template id, exactly. */
  template: string;
  /**
   * The earliest `createdAt` to consider, inclusive.
   *
   * Required, with no default. An unbounded question against an append-only send log is a table scan
   * whose cost grows with the project's age, asked on the path that decides whether to send — and a
   * default would be this module choosing how far back "already" reaches, which is the caller's
   * decision and differs per notice.
   */
  since: Date;
  /** How many rows to return, clamped into range. The default is `DEFAULT_PAGE_SIZE`. */
  limit?: number;
}

/** What went out, and whether the bound cut the answer short. */
export interface SentLog {
  /** The matching jobs, newest first, at most the clamped limit. */
  items: SentSummary[];
  /** True when more rows matched than the limit allowed. A count taken off `items` is wrong when this is set. */
  truncated: boolean;
}

/**
 * Every job of one template to one recipient since an instant, newest first.
 *
 * **A row that will not parse throws.** It is tempting to skip it and carry on, and it is wrong here in
 * a way it is not on a listing: this reader's answer decides whether a message goes out. A skipped row
 * is reported as an email that never went, which means a duplicate send — or, where the caller is
 * looking for who to send a *correction* to, a correction withheld from exactly the person owed one.
 * Both failures are silent and neither is recoverable after the fact, so a row this schema cannot read
 * stops the decision instead of quietly biasing it.
 */
export async function sentSince(db: EmailDatabase, filter: SentFilter): Promise<SentLog> {
  const limit = pageLimit(filter.limit);
  const rows = await db
    .selectFrom("pithyEmailJobs")
    .select(["id", "status", "createdAt", "sentAt"])
    // `recipientKey`, never `toAddress`: the row keeps what the caller typed and this is the column
    // every comparison is against. The index is `(recipientKey, template, createdAt)`.
    .where("recipientKey", "=", normalizeAddress(filter.to))
    .where("template", "=", filter.template)
    .where("createdAt", ">=", filter.since.getTime())
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    // One more than asked for, so "was there more" is answerable without a second count query.
    .limit(limit + 1)
    .execute();

  const items = rows.slice(0, limit).map((row) => {
    const parsed = SentSummary.safeParse(row);
    if (!parsed.success) {
      throw new InternalError({
        message: "The send log could not be read.",
        action: "Inspect pithy_email_jobs for a row this deployment's schema cannot decode.",
        // The row id only. The values that failed to parse are the row, and the row is somebody's mail.
        detail: `pithy_email_jobs row '${String(row.id)}' does not satisfy EmailJob: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
          .join("; ")}`,
      });
    }
    return parsed.data;
  });

  return { items, truncated: rows.length > limit };
}
