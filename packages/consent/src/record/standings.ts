// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ConsentMethod, type ConsentPurpose, meetsMethod } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentPurposeStanding } from "@pithy-sh/core/src/consent/reader";
import { sql } from "kysely";
import type { ConsentAction } from "../data/enums";
import type { ConsentDatabase } from "../data/tables";

/**
 * Where each purpose's subjects stand now, for the processing record: how many chose a grant last, how many a
 * withdrawal, and how many `hasConsent` answers yes for. A subject is counted once, by its latest row, with a merged
 * visitor counted as its account, exactly as `./counts.ts` counts them.
 */

/** Subjects whose latest row shares every fact the standing turns on. */
export interface LatestChoiceGroup {
  readonly purpose: string;
  readonly noticeVersion: number;
  readonly action: ConsentAction;
  readonly method: ConsentMethod;
  /** The row carried an expiry, and it has passed. */
  readonly expired: boolean;
  /** The row is an unmerged visitor's, written longer ago than the visitor window. */
  readonly lapsed: boolean;
  readonly subjects: number;
}

/**
 * Every purpose in the catalog with its counts, in catalog order. A purpose nobody has chosen on counts zero; rows for
 * a purpose the catalog no longer holds are left out. Standing applies `hasConsent`'s rules to each group.
 */
export function tallyStandings(
  catalog: ReadonlyMap<string, ConsentPurpose>,
  groups: readonly LatestChoiceGroup[],
): ConsentPurposeStanding[] {
  return [...catalog.values()].map((purpose) => {
    let grants = 0;
    let withdrawals = 0;
    let standing = 0;
    for (const group of groups) {
      if (group.purpose !== purpose.id) continue;
      if (group.action === "withdraw") {
        withdrawals += group.subjects;
        continue;
      }
      grants += group.subjects;
      const holds =
        !group.expired &&
        !group.lapsed &&
        group.noticeVersion === purpose.noticeVersion &&
        meetsMethod(group.method, purpose.minimumMethod);
      if (holds) standing += group.subjects;
    }
    return { purpose, grants, withdrawals, standing };
  });
}

/** One SQL pass: the latest row per subject and purpose, grouped by the facts its standing turns on. */
export async function latestChoiceGroups(
  db: ConsentDatabase,
  now: Date,
  visitorWindowMs: number,
): Promise<LatestChoiceGroup[]> {
  const at = now.getTime();
  const { rows } = await sql<{
    purpose: string;
    noticeVersion: number;
    action: ConsentAction;
    method: ConsentMethod;
    expired: number;
    lapsed: number;
    subjects: number;
  }>`
    SELECT purpose, notice_version AS "noticeVersion", action, method,
      CASE WHEN expires_at IS NOT NULL AND expires_at <= ${at} THEN 1 ELSE 0 END AS expired,
      CASE WHEN subject_kind = 'visitor' AND merged = 0 AND recorded_at + ${visitorWindowMs} <= ${at} THEN 1 ELSE 0 END
        AS lapsed,
      COUNT(*) AS subjects
    FROM (
      SELECT record.purpose, record.notice_version, record.action, record.method, record.expires_at,
        record.recorded_at, record.subject_kind,
        CASE WHEN merge.user_id IS NULL THEN 0 ELSE 1 END AS merged,
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
    )
    WHERE position = 1
    GROUP BY purpose, notice_version, action, method, expired, lapsed
    ORDER BY purpose, notice_version
  `.execute(db);
  return rows.map((row) => ({
    purpose: row.purpose,
    noticeVersion: Number(row.noticeVersion),
    action: row.action,
    method: row.method,
    expired: Number(row.expired) === 1,
    lapsed: Number(row.lapsed) === 1,
    subjects: Number(row.subjects),
  }));
}

/** Every catalog purpose, with where its subjects stand at `now`. */
export async function consentStandings(
  db: ConsentDatabase,
  catalog: ReadonlyMap<string, ConsentPurpose>,
  now: Date,
  visitorWindowMs: number,
): Promise<ConsentPurposeStanding[]> {
  return tallyStandings(catalog, await latestChoiceGroups(db, now, visitorWindowMs));
}
