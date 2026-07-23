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
 * One entry in the append-only ledger — the row in `pithy_wallet_transactions`. Never updated or deleted:
 * the account's materialized balance is the running total, and this log is the auditable history that
 * explains it.
 *
 * `ref` is the caller-supplied idempotency key, unique across the whole ledger. Replaying an operation with
 * a `ref` that already exists is a no-op — the unique constraint aborts the retry's transaction, so a
 * payout or a debit applies exactly once however many times it is delivered.
 */
export const WalletTransaction = z
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
        "Links this entry to another: a `release`/`capture` to its `hold`'s ref, or the paired sides of a transfer.",
      ),
    memo: z.string().nullable().describe("An optional human-readable note — `blackjack payout`, `daily bonus`."),
    createdAt: SQLiteDate.describe("When this entry was recorded."),
  })
  .describe("One entry in the append-only wallet ledger — the row in `pithy_wallet_transactions`.");
export type WalletTransaction = z.output<typeof WalletTransaction>;
export type WalletTransactionRow = z.input<typeof WalletTransaction>;
