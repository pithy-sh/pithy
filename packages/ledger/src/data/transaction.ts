// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/** What a ledger entry represents. The append-only log records every balance movement by kind. */
export const TransactionKind = z
  .enum(["credit", "debit", "hold", "release", "capture", "transfer_in", "transfer_out"])
  .describe(
    "The movement this entry records: `credit`/`debit` add or remove funds; `hold`/`release`/`capture` open, cancel, or finalize an escrow; `transfer_in`/`transfer_out` are the two sides of a transfer.",
  );
export type TransactionKind = z.infer<typeof TransactionKind>;

/**
 * The suffixes the ledger writes onto a ref itself: a reversal is `<ref>:reverse`, a hold's release or
 * capture is `<hold>:resolve`, and a transfer's two sides are `<ref>:out` and `<ref>:in`.
 *
 * **A control-plane credit or debit may not take one.** Refs are unique across the whole log, so a credit
 * under `refund-7:reverse` would take the ref a later reversal of `refund-7` needs. The control-plane request
 * schema refuses it before anything is written. In process, and on the player-facing `ledger:admin` routes, a
 * ref is the caller's as it always was; a collision there is caught when the derived write runs, as
 * `ledger/ref_conflict`, never answered as a replay. A colon anywhere else is the caller's everywhere —
 * `payments:grant:p-1:chips` is a ref like any other.
 */
export const RESERVED_REF_SUFFIXES = [":reverse", ":resolve", ":out", ":in"] as const;

/** Whether a ref ends in a suffix the ledger derives — one a credit, a debit or a hold may not take. */
export function isReservedRef(ref: string): boolean {
  return RESERVED_REF_SUFFIXES.some((suffix) => ref.endsWith(suffix));
}

/**
 * One entry in the append-only ledger — the row in `pithy_ledger_transactions`. Never updated or deleted:
 * the account's materialized balance is the running total, and this log is the auditable history that
 * explains it.
 *
 * `ref` is the caller-supplied idempotency key, unique across the whole ledger. Replaying an operation with
 * a `ref` that already exists is a no-op — the unique constraint aborts the retry's transaction, so a
 * payout or a debit applies exactly once however many times it is delivered.
 */
export const LedgerTransaction = z
  .object({
    id: z.number().int().describe("Autoincrement primary key. Internal only."),
    ref: z
      .string()
      .describe("The caller-supplied idempotency key, unique across the ledger. A replay of the same ref is a no-op."),
    userId: z.string().describe("The account owner this entry moved funds for."),
    currency: z.string().describe("The currency code this entry is in."),
    kind: TransactionKind.describe("What this entry represents."),
    amount: z
      .number()
      .int()
      .describe("The movement's magnitude in the currency's minor unit — always positive; `kind` gives direction."),
    relatedRef: z
      .string()
      .nullable()
      .describe(
        "Links this entry to another: a `release`/`capture` to its `hold`'s ref, the paired sides of a transfer, or a reversal — a `credit` or `debit` under `<ref>:reverse` — to the entry it reversed.",
      ),
    memo: z.string().nullable().describe("An optional human-readable note — `blackjack payout`, `daily bonus`."),
    createdAt: SQLiteDate.describe("When this entry was recorded."),
  })
  .describe("One entry in the append-only ledger — the row in `pithy_ledger_transactions`.");
export type LedgerTransaction = z.output<typeof LedgerTransaction>;
export type LedgerTransactionRow = z.input<typeof LedgerTransaction>;
