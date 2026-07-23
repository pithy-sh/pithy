import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { WalletAccount } from "./account";
import { WalletHold } from "./hold";
import { WalletTransaction } from "./transaction";

/** The accounts table. `CamelCasePlugin` snake-cases it to `pithy_wallet_accounts`. */
export const WALLET_ACCOUNTS_TABLE = "pithyWalletAccounts";
/** The ledger table. `CamelCasePlugin` snake-cases it to `pithy_wallet_transactions`. */
export const WALLET_TRANSACTIONS_TABLE = "pithyWalletTransactions";
/** The holds table. `CamelCasePlugin` snake-cases it to `pithy_wallet_holds`. */
export const WALLET_HOLDS_TABLE = "pithyWalletHolds";

/** The wallet tables map. All are always present — none is behind a config flag. */
export function walletTables(): Record<string, z.ZodObject> {
  return {
    [WALLET_ACCOUNTS_TABLE]: WalletAccount,
    [WALLET_TRANSACTIONS_TABLE]: WalletTransaction,
    [WALLET_HOLDS_TABLE]: WalletHold,
  };
}

/** The typed Kysely database over the wallet tables. */
export type WalletTables = {
  [WALLET_ACCOUNTS_TABLE]: typeof WalletAccount;
  [WALLET_TRANSACTIONS_TABLE]: typeof WalletTransaction;
  [WALLET_HOLDS_TABLE]: typeof WalletHold;
};
export type WalletDatabase = Kysely<DatabaseSchema<WalletTables>>;

/** Build the wallet database from the `DB` binding (CamelCasePlugin installed). */
export function walletDatabase(d1: D1Database): WalletDatabase {
  return createDatabase(d1, {
    [WALLET_ACCOUNTS_TABLE]: WalletAccount,
    [WALLET_TRANSACTIONS_TABLE]: WalletTransaction,
    [WALLET_HOLDS_TABLE]: WalletHold,
  }) as unknown as WalletDatabase;
}
