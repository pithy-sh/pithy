// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sql } from "kysely";
import type { ConsentDatabase } from "../data/tables";

/**
 * Counts per purpose and notice version, for the control plane: how many subjects stand granted under each
 * version, and how many stand withdrawn. A subject is counted once, by the latest row it wrote for the purpose — the
 * same row `hasConsent` decides on — so a grant later withdrawn counts as a withdrawal and never as both.
 *
 * A visitor merged into an account is counted as that account, exactly as `hasConsent` reads it: the visitor's rows
 * and the account's are one history, and the latest of them decides. So a visitor who granted, signed in, and
 * withdrew from settings is one withdrawal, never a grant beside it. A visitor not merged is its own subject.
 */
export interface ConsentVersionCount {
  readonly purpose: string;
  readonly noticeVersion: number;
  readonly grants: number;
  readonly withdrawals: number;
}

/** One SQL pass: the latest row per subject (a merged visitor under its account) and purpose, grouped by purpose, version and action. */
export async function consentCounts(db: ConsentDatabase): Promise<ConsentVersionCount[]> {
  const { rows } = await sql<{ purpose: string; noticeVersion: number; action: string; subjects: number }>`
    SELECT purpose, notice_version AS "noticeVersion", action, COUNT(*) AS subjects
    FROM (
      SELECT record.purpose, record.notice_version, record.action,
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
    GROUP BY purpose, notice_version, action
    ORDER BY purpose, notice_version
  `.execute(db);
  const counts = new Map<string, ConsentVersionCount>();
  for (const row of rows) {
    const key = `${row.purpose}\u0000${row.noticeVersion}`;
    const current = counts.get(key) ?? {
      purpose: row.purpose,
      noticeVersion: Number(row.noticeVersion),
      grants: 0,
      withdrawals: 0,
    };
    counts.set(key, {
      ...current,
      grants: current.grants + (row.action === "grant" ? Number(row.subjects) : 0),
      withdrawals: current.withdrawals + (row.action === "withdraw" ? Number(row.subjects) : 0),
    });
  }
  return [...counts.values()];
}
