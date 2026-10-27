// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **Every management read is audited, not only the writes.** A ledger is a record of what people own and
 * what they did to earn or spend it; a management credential that can page through it can reconstruct a
 * player's whole economic history. "Who pulled the balances for every account on the ninth, and whose
 * transaction log did they open afterwards" is a question with an answer, and these are what make it
 * one. An unaudited read surface over other people's money is how a leaked dashboard credential stays
 * invisible — nothing changes, so nothing shows up. A read records identifiers and counts only: never a
 * balance, never a memo, never a `ref`. The trail is queryable and long-lived, and copying the ledger
 * into it would just make a second ledger with weaker access rules than the first.
 *
 * **A management write records what it did, because that is the point of the record.** Severity
 * `warning`: the account, the act, the ref it wrote, the amount, the operator's reason verbatim, and the
 * balance before and after. One event per write that moved money; a replay moved nothing and records
 * nothing, and so does a refusal.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present
 * (`noopEmit` when no audit capability is composed), so there is no null check and no hard dependency.
 */
export const LedgerAuditActions = {
  /** A management client paged the account list — every holder of a balance, or of one currency's. */
  accountsListed: "ledger/accounts_listed",
  /** A management client read one player's balances. */
  accountRead: "ledger/account_read",
  /** A management client paged one account's entry log — the history behind the number. */
  transactionsRead: "ledger/transactions_read",
  /** A management client added funds to one account. */
  accountCredited: "ledger/account_credited",
  /** A management client removed funds from one account. */
  accountDebited: "ledger/account_debited",
  /** A management client reversed one credit or debit, by posting its opposite. */
  entryReversed: "ledger/entry_reversed",
  /** A management client released one open hold. */
  holdReleased: "ledger/hold_released",
} as const;

/** One of the ledger capability's audit actions. */
export type LedgerAuditAction = (typeof LedgerAuditActions)[keyof typeof LedgerAuditActions];
