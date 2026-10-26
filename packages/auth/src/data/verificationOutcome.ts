// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * `pithy_auth_verification_outcomes` — the verification ledger (#829): one row per sign-in link or code auth
 * issued, and whether it was used.
 *
 * **Why a ledger, and not a read of `pithy_auth_verifications`.** Better Auth consumes a verification row on its
 * first use and deletes it, so a used link leaves nothing behind, and an unused one looks exactly like one still
 * waiting until the cleanup on some later read takes it. "How many sign-ins failed because mail did not land"
 * needs both halves, so auth writes its own record: when it issues, and again when the link or code is used.
 *
 * **Never the token, never the address.** The row names the verification by its row id, the person by their user
 * id where one exists, and the mail by its `pithy_email_jobs` id — which is where the address already lives,
 * under email's own retention. A sign-up has no user when its link is sent, so its row joins to its mail by the
 * job id alone and gains the user id when the link is used and the account exists.
 *
 * **No foreign key, to the user or to the job.** The two live in different capabilities' tables, and a purge of
 * the account erases its rows here by user id (`../purge/contribution.ts`).
 *
 * Written by the kit through its own Kysely, so its dates take the house ms-epoch `SQLiteDate`.
 */

/** What was issued. */
export const VerificationType = z
  .enum(["magic_link", "otp"])
  .describe(
    "What was issued: `magic_link`, a sign-in link; `otp`, a one-time sign-in code. The only two auth sends — it composes no password, so no reset, and no separate email-verification mail.",
  );
export type VerificationType = z.output<typeof VerificationType>;

/** One issued link or code, as stored. */
export const VerificationOutcome = z
  .object({
    id: z
      .number()
      .int()
      .describe("Primary key. Auto-incrementing, so two rows issued in the same millisecond keep their order."),
    verificationId: z
      .string()
      .describe(
        "The `pithy_auth_verifications` row that carries this link or code. A wrong code is re-issued under a new row with the same expiry, and this follows it. Indexed.",
      ),
    type: VerificationType.describe("What was issued."),
    userId: z
      .string()
      .nullable()
      .describe(
        "The account it signs in to, when one existed at issue or was created by its use. Null for a sign-up nobody completed. Indexed, so a purge finds the account's rows.",
      ),
    emailJobId: z
      .string()
      .nullable()
      .describe(
        "The `pithy_email_jobs` row that carried it — how a reader joins it to a bounce, a deferral or a suppression. Null when the email seam failed and nothing was queued.",
      ),
    issuedAt: SQLiteDate.describe("When it was issued. Ms-epoch in SQLite; a `Date` in app code."),
    expiresAt: SQLiteDate.describe("When it stops working, used or not. Ms-epoch in SQLite."),
    usedAt: SQLiteDate.nullable().describe(
      "When it was used to sign in, or null while it has not been. Ms-epoch in SQLite.",
    ),
  })
  .describe(
    "One sign-in link or code in `pithy_auth_verification_outcomes`: what it was, whose, the mail that carried it, and when it was issued, expires and was used. Never the token or the address.",
  );
export type VerificationOutcome = z.output<typeof VerificationOutcome>;

/** Where an issued link or code stands at a moment: used, expired unused, or still pending. */
export const VerificationState = z
  .enum(["used", "expired", "pending"])
  .describe(
    "Where it stands: `used`, it signed somebody in; `expired`, it ran out unused; `pending`, it is unused and still works.",
  );
export type VerificationState = z.output<typeof VerificationState>;

/** Where one row stands at `now`. Used wins over expiry: a link used a second before it ran out was used. */
export function verificationStateAt(
  row: Pick<VerificationOutcome, "expiresAt" | "usedAt">,
  now: Date,
): VerificationState {
  if (row.usedAt !== null) return "used";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}
