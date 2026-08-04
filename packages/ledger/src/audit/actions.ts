// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit actions this capability emits, through the core `emit()` seam.
 *
 * **Every one of these is a read, and every one is audited anyway.** A ledger is a record of what
 * people own and what they did to earn or spend it; a management credential that can page through it
 * can reconstruct a player's whole economic history. "Who pulled the balances for every account on the
 * ninth, and whose transaction log did they open afterwards" is a question with an answer, and these
 * are what make it one. An unaudited read surface over other people's money is how a leaked dashboard
 * credential stays invisible — nothing changes, so nothing shows up.
 *
 * Emitted with `c.var.emit`, never by importing `@pithy-sh/audit` — the seam is always present
 * (`noopEmit` when no audit capability is composed), so there is no null check and no hard dependency.
 * Identifiers and counts only in metadata: never a balance, never a memo, never a `ref`. The trail is
 * queryable and long-lived, and copying the ledger into it would just make a second ledger with weaker
 * access rules than the first.
 */
export const LedgerAuditActions = {
  /** A management client paged the account list — every holder of a balance, or of one currency's. */
  accountsListed: "ledger/accounts_listed",
  /** A management client read one player's balances. */
  accountRead: "ledger/account_read",
  /** A management client paged one account's entry log — the history behind the number. */
  transactionsRead: "ledger/transactions_read",
} as const;

/** One of the ledger capability's audit actions. */
export type LedgerAuditAction = (typeof LedgerAuditActions)[keyof typeof LedgerAuditActions];
