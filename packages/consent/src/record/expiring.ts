// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentMethod } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentSubject } from "@pithy-sh/core/src/consent/reader";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { sql } from "kysely";
import type { ConsentSubjectKind } from "../data/enums";
import type { ConsentDatabase } from "../data/tables";

/**
 * The signed grants that have expired or soon will, for the control plane: each subject's latest row per purpose,
 * when that row is a grant with an expiry at or before the horizon. A subject is named as `./counts.ts` counts it —
 * a visitor merged into an account is that account — so the list and the `expired` count agree. Soonest first,
 * paged by `(expiresAt, recordId)`.
 */

/** One grant on the list: the facts of the row, never the typed name or the representative. */
export interface ExpiringGrant {
  readonly recordId: string;
  readonly subject: ConsentSubject;
  readonly purpose: string;
  readonly noticeVersion: number;
  readonly method: ConsentMethod;
  readonly expiresAt: Date;
  /** The expiry is at or before `now`, as `hasConsent` reads it. */
  readonly expired: boolean;
  readonly documentHash: string | null;
}

/** What to list. */
export interface ExpiringQuery {
  /** The catalog's purpose ids. A row for any other purpose is left out, as the counts leave it out. */
  readonly purposes: readonly string[];
  readonly now: Date;
  /** The last instant an expiry may fall on to be listed. */
  readonly horizon: Date;
  /** The previous page's `nextCursor`. A malformed one is a first page. */
  readonly cursor?: string;
  readonly limit?: number;
}

/** One page of the list. */
export interface ExpiringPage {
  readonly grants: ExpiringGrant[];
  readonly nextCursor: string | null;
}

/** One SQL pass: the latest row per subject and purpose, kept when it is a grant expiring by the horizon. */
export async function expiringGrants(db: ConsentDatabase, query: ExpiringQuery): Promise<ExpiringPage> {
  if (query.purposes.length === 0) return { grants: [], nextCursor: null };
  const limit = pageLimit(query.limit);
  const position = decodeCursor(query.cursor);
  const after =
    position === undefined || typeof position.sort !== "number"
      ? sql`1 = 1`
      : sql`(expires_at > ${position.sort} OR (expires_at = ${position.sort} AND id > ${String(position.id)}))`;
  const at = query.now.getTime();
  const { rows } = await sql<{
    id: string;
    subjectKind: ConsentSubjectKind;
    subjectId: string;
    purpose: string;
    noticeVersion: number;
    method: ConsentMethod;
    expiresAt: number;
    documentHash: string | null;
  }>`
    SELECT id, subject_kind AS "subjectKind", subject_id AS "subjectId", purpose, notice_version AS "noticeVersion",
      method, expires_at AS "expiresAt", document_hash AS "documentHash"
    FROM (
      SELECT record.id, record.purpose, record.notice_version, record.action, record.method, record.expires_at,
        record.document_hash,
        CASE WHEN merge.user_id IS NULL THEN record.subject_kind ELSE 'account' END AS subject_kind,
        COALESCE(merge.user_id, record.subject_id) AS subject_id,
        ROW_NUMBER() OVER (
          PARTITION BY
            CASE WHEN merge.user_id IS NULL THEN record.subject_kind ELSE 'account' END,
            COALESCE(merge.user_id, record.subject_id),
            record.purpose
          ORDER BY record.recorded_at DESC, record.rowid DESC
        ) AS position
      FROM pithy_consent_records AS record
      LEFT JOIN pithy_consent_merges AS merge
        ON record.subject_kind = 'visitor' AND merge.visitor_id = record.subject_id
      WHERE record.purpose IN (${sql.join(query.purposes)})
    )
    WHERE position = 1
      AND action = 'grant'
      AND expires_at IS NOT NULL
      AND expires_at <= ${query.horizon.getTime()}
      AND ${after}
    ORDER BY expires_at ASC, id ASC
    LIMIT ${limit + 1}
  `.execute(db);
  const grants = rows.map((row): ExpiringGrant => {
    const expiresAt = SQLiteDate.parse(row.expiresAt);
    return {
      recordId: row.id,
      subject: { kind: row.subjectKind, id: row.subjectId },
      purpose: row.purpose,
      noticeVersion: Number(row.noticeVersion),
      method: row.method,
      expiresAt,
      expired: expiresAt.getTime() <= at,
      documentHash: row.documentHash,
    };
  });
  const page = toPage(grants, limit, (grant) => ({ sort: grant.expiresAt.getTime(), id: grant.recordId }));
  return { grants: page.items, nextCursor: page.nextCursor };
}
