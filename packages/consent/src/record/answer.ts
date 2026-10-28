// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ConsentMethod, type ConsentPurpose, meetsMethod } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentAction, ConsentSubjectKind } from "../data/enums";

/**
 * Whether a subject holds consent to a purpose now — the whole of `hasConsent`, over rows already read.
 *
 * Pure, so every reason it can answer no is asserted directly: a withdrawal after the grant, an expired grant, one
 * under an older notice version, one below the purpose's minimum method, and a visitor's grant past the anonymous
 * window with no merge behind it.
 */

/** What the answer reads of one row: the facts, never the evidence. */
export interface AnswerRow {
  readonly subjectKind: ConsentSubjectKind;
  readonly action: ConsentAction;
  readonly noticeVersion: number;
  readonly method: ConsentMethod;
  readonly expiresAt: Date | null;
  readonly recordedAt: Date;
  /** Whether this row is a visitor's that was merged into an account — merged rows do not age out. */
  readonly merged: boolean;
}

/** Why an answer is no, or `granted`. Named, so the control plane and the tests say which. */
export type ConsentStanding =
  | "granted"
  | "never_granted"
  | "withdrawn"
  | "expired"
  | "stale_notice"
  | "below_minimum"
  | "visitor_expired"
  | "unknown_purpose";

/** The row that decides: the latest, in the order they were written. */
export function deciding<T extends Pick<AnswerRow, "action" | "recordedAt">>(rows: readonly T[]): T | undefined {
  let latest: T | undefined;
  for (const row of rows) {
    if (latest === undefined || row.recordedAt.getTime() >= latest.recordedAt.getTime()) latest = row;
  }
  return latest;
}

/**
 * The standing of a subject on one purpose. `rows` are every row about this purpose for the subject, and for an
 * account every row of the visitors merged into it, in the order they were written; the latest decides.
 */
export function standing(
  purpose: ConsentPurpose | undefined,
  rows: readonly AnswerRow[],
  now: Date,
  visitorWindowMs: number,
): ConsentStanding {
  if (purpose === undefined) return "unknown_purpose";
  const latest = deciding(rows);
  if (latest === undefined) return "never_granted";
  if (latest.action === "withdraw") return "withdrawn";
  if (latest.expiresAt !== null && latest.expiresAt.getTime() <= now.getTime()) return "expired";
  if (latest.noticeVersion !== purpose.noticeVersion) return "stale_notice";
  if (!meetsMethod(latest.method, purpose.minimumMethod)) return "below_minimum";
  if (latest.subjectKind === "visitor" && !latest.merged) {
    if (latest.recordedAt.getTime() + visitorWindowMs <= now.getTime()) return "visitor_expired";
  }
  return "granted";
}

/** The latest grant still standing behind a withdrawal — what a written withdrawal is held to. */
export function standingGrant<T extends Pick<AnswerRow, "action" | "recordedAt">>(rows: readonly T[]): T | undefined {
  const latest = deciding(rows);
  return latest?.action === "grant" ? latest : undefined;
}
