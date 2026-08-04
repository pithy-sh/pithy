// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { LedgerAccount } from "../data/account";
import type { LedgerTransaction, TransactionKind } from "../data/transaction";

/**
 * What a management client is shown. Deliberate projections, never a raw row.
 *
 * ## What the ledger holds, and therefore what this can leak
 *
 * The ledger stores no names, no email addresses, and no payment instruments — it never has any. The
 * only identity field on either table is `userId`, the opaque id the adopter's auth capability issued,
 * and a management client already has to name one to read anything about a person. So the PII question
 * here is not "which column is sensitive" but **"what does the shape of somebody's balance history say
 * about them"**, and the answer is: a great deal. That is a scope decision rather than a projection one,
 * and it is made in `guards.ts`.
 *
 * ## What is dropped, and why
 *
 * - **`id`, on both rows.** An autoincrement primary key, described in both schemas as internal. A
 *   management client addresses an account by `(userId, currency)` and an entry by `ref`, both of which
 *   are stable and meaningful; the surrogate key is neither, and putting it in a response is how a
 *   client comes to depend on it. Position in the list is the cursor's job.
 * - **`userId`, on an entry.** Every entry in a page came from one account, and the route named that
 *   account. Repeating it on each row would be noise a client has to be trusted to ignore.
 *
 * ## What is kept, and why
 *
 * `ref`, `relatedRef`, and `memo` are adopter-authored strings, and they are the entire reason the
 * entry log is worth reading: `ref` is what correlates a movement with the purchase or the hand that
 * caused it, `relatedRef` is what ties a capture back to its hold and one side of a transfer to the
 * other, and `memo` is the sentence an operator answering "why is my chip count wrong" actually needs.
 * An adopter who writes something sensitive into a memo has put it in their own ledger; what this
 * decides is that reading them is its own scope, not that they are unreadable.
 *
 * Dates render as ISO-8601 strings. They are ms-epoch integers in SQLite and `Date`s in TypeScript, and
 * a JSON number would leave every client guessing which unit it was in.
 */

/** One account, as a management client sees it. */
export interface LedgerAccountView {
  /** The account owner — the opaque user id the adopter's auth capability issued. */
  userId: string;
  /** The currency this balance is in. */
  currency: string;
  /** Total owned, in the currency's minor unit. */
  balance: number;
  /** The portion reserved by open holds. */
  held: number;
  /** Spendable now (`balance - held`). Computed, so a client never has to know the rule. */
  available: number;
  /** When the account was opened, ISO-8601. */
  createdAt: string;
  /** When the balance last changed, ISO-8601. */
  updatedAt: string;
}

/** One ledger entry, as a management client sees it. */
export interface LedgerTransactionView {
  /** The caller-supplied idempotency key, unique across the ledger — the entry's stable identifier. */
  ref: string;
  /** What the movement was. */
  kind: TransactionKind;
  /** The currency the movement was in. */
  currency: string;
  /** The movement's magnitude in the minor unit — always positive; `kind` gives direction. */
  amount: number;
  /** The entry this one answers: a hold's ref, or the other side of a transfer. Null when standalone. */
  relatedRef: string | null;
  /** The adopter's own note on the movement, or null. */
  memo: string | null;
  /** When the movement was recorded, ISO-8601. */
  createdAt: string;
}

/** Project one account row for a management client. */
export function accountView(account: LedgerAccount): LedgerAccountView {
  return {
    userId: account.userId,
    currency: account.currency,
    balance: account.balance,
    held: account.held,
    available: account.balance - account.held,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/** Project one ledger entry for a management client. */
export function transactionView(entry: LedgerTransaction): LedgerTransactionView {
  return {
    ref: entry.ref,
    kind: entry.kind,
    currency: entry.currency,
    amount: entry.amount,
    relatedRef: entry.relatedRef,
    memo: entry.memo,
    createdAt: entry.createdAt.toISOString(),
  };
}
