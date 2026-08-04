// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AuditActorType, AuditOutcome, AuditSeverity } from "@pithy-sh/core/src/audit/auditEvent";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, type PageCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { AuditEventRow } from "./data/auditEvent";
import type { AuditDatabase } from "./data/tables";

/**
 * A filter over the audit trail. Every field is optional and ANDed together; an empty filter returns
 * the whole trail (newest first). This is the typed read seam consumers use to read events by actor,
 * action, time range, resource, outcome, and severity.
 *
 * It is a Kysely query first: `src/http/routes.ts` is the control-plane surface over it, and it is
 * this package's own contribution behind `requireControlPlane(scope)` rather than something core
 * reaches in and adds. `actorType: "control-plane"` is what separates a management client's actions
 * from the adopter's own users', which is the question that surface is actually asked.
 */
export interface AuditQuery {
  /** Match the acting principal's kind. */
  actorType?: AuditActorType;
  /** Match the acting principal's id. */
  actorId?: string;
  /** Match an exact `domain/reason` action code. */
  action?: string;
  /** Match the outcome (`success` | `failure` | `denied`). */
  outcome?: AuditOutcome;
  /** Match the severity (`info` | `warning` | `critical`). */
  severity?: AuditSeverity;
  /** Match the targeted resource's type. */
  resourceType?: string;
  /** Match the targeted resource's id. */
  resourceId?: string;
  /** Match the project the event was recorded in. */
  project?: string;
  /** Match the environment the recording Worker served. */
  environment?: string;
  /** Match the recording Worker's `apps/<name>` directory name. */
  worker?: string;
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Inclusive upper bound on `occurredAt`. */
  to?: Date;
  /**
   * Cap the number of rows returned. {@link queryAuditEvents} uses it verbatim; {@link pageAuditEvents}
   * clamps it into `[1, MAX_PAGE_SIZE]`, because that one answers a caller over HTTP.
   */
  limit?: number;
  /**
   * Where to resume, from the previous page's `nextCursor`. Read only by {@link pageAuditEvents}, and
   * opaque — a malformed one is a first page, never an error (see `@pithy-sh/core/src/data/cursor`).
   */
  cursor?: string;
}

/**
 * One page of the trail, and where the next one starts.
 *
 * `nextCursor` is null at the end of the list, and knowing that costs no `COUNT` — the query
 * over-fetches by one row and {@link toPage} drops it. On the largest table in most projects, a count
 * query per page is the difference between a page load and a table scan.
 */
export interface AuditEventPage {
  /** The page, newest first. */
  events: AuditEventRow[];
  /** Where the next page starts, or null at the end of the trail. */
  nextCursor: string | null;
}

/**
 * The filtered, ordered query both readers run — one builder, so a filter can never mean two things.
 *
 * The order is `(occurredAt desc, id desc)` and it is not an incidental choice: it is what the keyset
 * cursor names a position in. `id` is the tiebreak, and without it two events recorded in the same
 * millisecond straddle a page boundary and one of them is skipped or returned twice — which on an
 * audit trail is a missing record, not a cosmetic glitch.
 */
function auditEventQuery(db: AuditDatabase, filter: AuditQuery) {
  let query = db.selectFrom("pithyAuditEvents").selectAll();

  if (filter.actorType !== undefined) query = query.where("actorType", "=", filter.actorType);
  if (filter.actorId !== undefined) query = query.where("actorId", "=", filter.actorId);
  if (filter.action !== undefined) query = query.where("action", "=", filter.action);
  if (filter.outcome !== undefined) query = query.where("outcome", "=", filter.outcome);
  if (filter.severity !== undefined) query = query.where("severity", "=", filter.severity);
  if (filter.resourceType !== undefined) query = query.where("resourceType", "=", filter.resourceType);
  if (filter.resourceId !== undefined) query = query.where("resourceId", "=", filter.resourceId);
  // The origin filters, in the composite index's column order — `project`, then `environment`, then
  // `worker` — so a narrowing query uses a leading subset of `pithyAuditEventsOriginIdx` rather than
  // scanning. Note these match a *recorded* origin: a row written before the columns existed has NULL
  // and is excluded by any of them, which is correct — it has no origin to match.
  if (filter.project !== undefined) query = query.where("project", "=", filter.project);
  if (filter.environment !== undefined) query = query.where("environment", "=", filter.environment);
  if (filter.worker !== undefined) query = query.where("worker", "=", filter.worker);
  if (filter.from !== undefined) query = query.where("occurredAt", ">=", SQLiteDate.encode(filter.from));
  if (filter.to !== undefined) query = query.where("occurredAt", "<=", SQLiteDate.encode(filter.to));

  return query.orderBy("occurredAt", "desc").orderBy("id", "desc");
}

/**
 * A decoded cursor, narrowed to the position this table's ordering can actually use.
 *
 * `occurredAt` is a **ms-epoch number** here, not an ISO string — Pithy's own tables store dates as
 * numbers, and only Better Auth's store them as TEXT. A cursor carrying a string would compare
 * lexically against an integer column and silently return the wrong page, so anything that is not a
 * pair of numbers is treated as no cursor at all. A bad cursor is a first page, which is the same
 * answer `decodeCursor` gives to a truncated or stale one.
 */
function keysetPosition(cursor: PageCursor | undefined): { sort: number; id: number } | undefined {
  if (!cursor) return undefined;
  if (typeof cursor.sort !== "number" || typeof cursor.id !== "number") return undefined;
  return { sort: cursor.sort, id: cursor.id };
}

/**
 * Read audit events matching `filter`, newest first (`occurredAt` then `id`, both descending). Each
 * row is decoded back through {@link AuditEventRow} — dates become `Date`s, `metadata` a parsed and
 * validated object — so callers get the app shape, never raw SQLite columns.
 */
export async function queryAuditEvents(db: AuditDatabase, filter: AuditQuery = {}): Promise<AuditEventRow[]> {
  let query = auditEventQuery(db, filter);
  if (filter.limit !== undefined) query = query.limit(filter.limit);
  const rows = await query.execute();
  return rows.map((row) => AuditEventRow.parse(row));
}

/**
 * One page of the trail, resumable — the read the control-plane route serves.
 *
 * **Keyset, never offset.** The audit table is appended to constantly while somebody is reading it, so
 * with `OFFSET` every event recorded during a read pushes one row from the page a client already has
 * onto the page it is about to fetch: it sees that row twice, and any row that fell off the far end it
 * never sees at all. On a security trail, "you may silently miss a record while paging" is not a
 * usability defect. The cursor names the last row's exact position instead, so the next page starts
 * where the previous ended whatever was written in between.
 */
export async function pageAuditEvents(db: AuditDatabase, filter: AuditQuery = {}): Promise<AuditEventPage> {
  const limit = pageLimit(filter.limit);
  const position = keysetPosition(decodeCursor(filter.cursor));

  let query = auditEventQuery(db, filter);
  if (position) {
    // The descending-keyset predicate: strictly older, or the same instant and a lower surrogate id.
    query = query.where((eb) =>
      eb.or([
        eb("occurredAt", "<", position.sort),
        eb.and([eb("occurredAt", "=", position.sort), eb("id", "<", position.id)]),
      ]),
    );
  }

  // One more than asked for: the extra row is how "is there another page" is answered without a count.
  const rows = await query.limit(limit + 1).execute();
  // Decoded before the split, so the cursor is derived from the app shape rather than from whichever
  // union the row type allows. `getTime()` is the ms-epoch the column actually stores — this table is
  // Pithy's own, so its dates are numbers, not the ISO-8601 TEXT Better Auth's tables hold.
  const decoded = rows.map((row) => AuditEventRow.parse(row));
  const page = toPage(decoded, limit, (row) => ({ sort: row.occurredAt.getTime(), id: row.id }));
  return { events: page.items, nextCursor: page.nextCursor };
}

/**
 * Read one event by its `eventId`, or null when there is none.
 *
 * Addressed by `eventId` — the recorder's UUID idempotency key, uniquely indexed — and never by the
 * autoincrement `id`. `id` is a surrogate that leaks how many events a project has recorded and is
 * guessable by counting; `eventId` is neither, and it is the value the trail's own idempotency
 * guarantee is written against.
 */
export async function readAuditEvent(db: AuditDatabase, eventId: string): Promise<AuditEventRow | null> {
  const row = await db.selectFrom("pithyAuditEvents").selectAll().where("eventId", "=", eventId).executeTakeFirst();
  return row ? AuditEventRow.parse(row) : null;
}
