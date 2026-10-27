// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { personRowsPurge } from "@pithy-sh/core/src/capability/personRows";
import type { ErasingPurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { LedgerAccount } from "../data/account";
import { LedgerHold } from "../data/hold";
import { LEDGER_ACCOUNTS_TABLE, LEDGER_HOLDS_TABLE, LEDGER_TRANSACTIONS_TABLE } from "../data/tables";
import { LedgerTransaction } from "../data/transaction";

/**
 * What erasing one person means for `@pithy-sh/ledger` (#814): every balance they hold, every entry in their
 * transaction log, and every hold — and what exporting them hands back.
 *
 * **Erased, not anonymized.** A ledger here is per person: each account is one user's balance in one currency, and
 * every entry and hold names the account it moved. Nothing another person holds adds up through these rows, so
 * there is no total that anonymizing would keep true and erasing would break.
 */

/** The one sentence the purge records with this step. */
export const LEDGER_PURGE_SUMMARY =
  "Deletes the user's balances in every currency, every entry in their transaction log, and their holds.";

/** The user contribution `ledger()` declares, over the D1 binding the ledger lives in. */
export function ledgerUserPurge(database = "DB"): ErasingPurgeContribution {
  return personRowsPurge({
    capability: "ledger",
    summary: LEDGER_PURGE_SUMMARY,
    database,
    tables: [
      {
        table: LEDGER_TRANSACTIONS_TABLE,
        schema: LedgerTransaction,
        columns: ["userId"],
        as: "transactions",
        orderBy: "id",
      },
      { table: LEDGER_HOLDS_TABLE, schema: LedgerHold, columns: ["userId"], as: "holds", orderBy: "id" },
      { table: LEDGER_ACCOUNTS_TABLE, schema: LedgerAccount, columns: ["userId"], as: "accounts", orderBy: "id" },
    ],
  });
}
