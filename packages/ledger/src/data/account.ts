// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One player's balance in one currency — the row in `pithy_ledger_accounts`, keyed `(userId, currency)`.
 *
 * `balance` is everything the player owns; `held` is the portion reserved by open holds (escrowed wagers).
 * `available = balance - held` is what they can spend. All three are integers in the currency's minor unit.
 * A database `CHECK (balance >= 0 AND held >= 0 AND held <= balance)` is the overdraft guard — a debit or
 * hold that would break it aborts its transaction, so an account can never go negative or over-reserve.
 */
export const LedgerAccount = z
  .object({
    id: z
      .number()
      .int()
      .describe("Autoincrement primary key. Internal only; accounts are addressed by (userId, currency)."),
    userId: z.string().describe("The account owner — an authenticated user id."),
    currency: z.string().describe("The currency code this balance is in, from `currencies` in pithy.config.ts."),
    balance: z.number().int().describe("Total owned, in the currency's minor unit. Never negative."),
    held: z
      .number()
      .int()
      .describe("The portion reserved by open holds. `available = balance - held`. Never exceeds balance."),
    createdAt: SQLiteDate.describe("When the account was first opened."),
    updatedAt: SQLiteDate.describe("When the balance last changed."),
  })
  .describe("One player's balance in one currency — the row in `pithy_ledger_accounts`.");
export type LedgerAccount = z.output<typeof LedgerAccount>;
export type LedgerAccountRow = z.input<typeof LedgerAccount>;

/** A player's spendable position in a currency — the shape a balance read returns. */
export interface Balance {
  /** Total owned. */
  balance: number;
  /** Reserved by open holds. */
  held: number;
  /** Spendable now (`balance - held`). */
  available: number;
}
