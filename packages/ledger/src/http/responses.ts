// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { TransactionKind } from "../data/transaction";

/**
 * What the ledger's management routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help — so every client that had only an interface hand-wrote a mirror, and the mirror drifted
 * the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 *
 * The projections live in `view.ts`, which documents *why* each surrogate key is dropped. This file is
 * the shape; that file is the argument.
 *
 * **A field added here later is `.optional()`, not merely `.nullable()`.** This module is read across a
 * version boundary — a management client validates a response with this schema against a customer's
 * Worker at whatever kit version it is on — so an additive required key fails `safeParse` for everyone
 * below that release and takes the whole pane with it (#450). Absent then means *this Worker cannot
 * say*, which is a different fact from `null`.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/** One account, as a management client sees it. */
export const LedgerAccountView = z
  .object({
    userId: z.string().describe("The account owner — the opaque user id the adopter's auth capability issued."),
    currency: z.string().describe("The currency this balance is in."),
    balance: z.number().int().describe("Total owned, in the currency's minor unit."),
    held: z.number().int().describe("The portion reserved by open holds."),
    available: z
      .number()
      .int()
      .describe("Spendable now (`balance - held`). Computed, so a client never has to know the rule."),
    createdAt: z.iso.datetime().describe("When the account was opened, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the balance last changed, ISO-8601."),
  })
  .describe("One account as a management client sees it. Addressed by `(userId, currency)`, never by a surrogate id.");
export type LedgerAccountView = z.output<typeof LedgerAccountView>;

/** One ledger entry, as a management client sees it. */
export const LedgerTransactionView = z
  .object({
    ref: z
      .string()
      .describe("The caller-supplied idempotency key, unique across the ledger — the entry's stable identifier."),
    kind: TransactionKind.describe("What the movement was."),
    currency: z.string().describe("The currency the movement was in."),
    amount: z
      .number()
      .int()
      .describe("The movement's magnitude in the minor unit — always positive; `kind` gives direction."),
    relatedRef: z
      .string()
      .nullable()
      .describe("The entry this one answers: a hold's ref, or the other side of a transfer. Null when standalone."),
    memo: z.string().nullable().describe("The adopter's own note on the movement, or null."),
    createdAt: z.iso.datetime().describe("When the movement was recorded, ISO-8601."),
  })
  .describe("One ledger entry as a management client sees it. No surrogate id, and no repeated owner.");
export type LedgerTransactionView = z.output<typeof LedgerTransactionView>;

/** `GET {base}/admin/accounts`. */
export const LedgerAccountsResponse = z
  .object({
    accounts: z.array(LedgerAccountView).describe("The page, most recently changed first."),
    nextCursor: NextCursor,
  })
  .describe("A page of every account this ledger holds.");
export type LedgerAccountsResponse = z.output<typeof LedgerAccountsResponse>;

/**
 * `GET {base}/admin/accounts/:userId`.
 *
 * An empty list rather than a 404 for a player who holds nothing: an account is opened by its first
 * credit, so its absence is not a missing person — and answering 404 would make this surface an
 * existence oracle for user ids.
 */
export const LedgerUserAccountsResponse = z
  .object({
    userId: z.string().describe("The player asked after, echoed so a response stands on its own."),
    accounts: z.array(LedgerAccountView).describe("Every currency this player holds. Empty when they hold none."),
  })
  .describe("One player's balances, in every currency they hold.");
export type LedgerUserAccountsResponse = z.output<typeof LedgerUserAccountsResponse>;

/** `GET {base}/admin/accounts/:userId/:currency/transactions`. */
export const LedgerTransactionsResponse = z
  .object({
    userId: z.string().describe("The account owner, echoed so a response stands on its own."),
    currency: z.string().describe("The currency, as the configured catalog spells it."),
    transactions: z.array(LedgerTransactionView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of one account's entry log.");
export type LedgerTransactionsResponse = z.output<typeof LedgerTransactionsResponse>;
