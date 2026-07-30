// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { SuppressionReason } from "../data/enums";
import type { EmailSuppressionDatabase } from "../data/tables";

/**
 * The suppression list: addresses that must not be emailed, fed by hard bounces, complaints, and
 * unsubscribes. The send path checks it before every send and skips a match. Addresses are normalized
 * (trimmed, lowercased) so a check and a write always agree on the key.
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
