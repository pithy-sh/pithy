// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { LedgerAccount } from "./account";
import { LedgerHold } from "./hold";
import { LedgerTransaction } from "./transaction";

/** The accounts table. `CamelCasePlugin` snake-cases it to `pithy_ledger_accounts`. */
export const LEDGER_ACCOUNTS_TABLE = "pithyLedgerAccounts";
/** The append-only entry log. `CamelCasePlugin` snake-cases it to `pithy_ledger_transactions`. */
export const LEDGER_TRANSACTIONS_TABLE = "pithyLedgerTransactions";
/** The holds table. `CamelCasePlugin` snake-cases it to `pithy_ledger_holds`. */
export const LEDGER_HOLDS_TABLE = "pithyLedgerHolds";

/** The ledger tables map. All are always present — none is behind a config flag. */
export function ledgerTables(): Record<string, z.ZodObject> {
  return {
    [LEDGER_ACCOUNTS_TABLE]: LedgerAccount,
    [LEDGER_TRANSACTIONS_TABLE]: LedgerTransaction,
    [LEDGER_HOLDS_TABLE]: LedgerHold,
  };
}

/** The typed Kysely database over the ledger tables. */
export type LedgerTables = {
  [LEDGER_ACCOUNTS_TABLE]: typeof LedgerAccount;
  [LEDGER_TRANSACTIONS_TABLE]: typeof LedgerTransaction;
  [LEDGER_HOLDS_TABLE]: typeof LedgerHold;
};
export type LedgerDatabase = Kysely<DatabaseSchema<LedgerTables>>;

/** Build the ledger database from the `DB` binding (CamelCasePlugin installed). */
export function ledgerDatabase(d1: D1Database): LedgerDatabase {
  return createDatabase(d1, {
    [LEDGER_ACCOUNTS_TABLE]: LedgerAccount,
    [LEDGER_TRANSACTIONS_TABLE]: LedgerTransaction,
    [LEDGER_HOLDS_TABLE]: LedgerHold,
  }) as unknown as LedgerDatabase;
}
