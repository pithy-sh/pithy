// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { LedgerAccount } from "../data/account";
import type { LedgerTransaction } from "../data/transaction";
import {
  LedgerAccountsResponse,
  LedgerAccountView,
  LedgerTransactionsResponse,
  LedgerTransactionView,
  LedgerUserAccountsResponse,
} from "./responses";
import { accountView, transactionView } from "./view";

/**
 * The response schemas against what the projections actually produce.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * projection that has grown a field the schema never heard of. Comparing the parsed value with the
 * input fails in both directions, which is what makes the two unable to drift silently.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const ACCOUNT: LedgerAccount = {
  id: 3,
  userId: "u-1",
  currency: "chips",
  balance: 1_200,
  held: 200,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const ENTRY: LedgerTransaction = {
  id: 9,
  ref: "purchase-4471",
  userId: "u-1",
  currency: "chips",
  kind: "capture",
  amount: 500,
  relatedRef: "hold-4471",
  memo: "Tournament buy-in",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

describe("ledger response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    accepts(LedgerAccountView, accountView(ACCOUNT));
    accepts(LedgerTransactionView, transactionView(ENTRY));
    accepts(LedgerTransactionView, transactionView({ ...ENTRY, relatedRef: null, memo: null }));
  });

  test("neither surrogate key is declared", () => {
    // A management client addresses an account by `(userId, currency)` and an entry by `ref`. Declaring
    // the autoincrement id would invite a client to depend on it, which is how an internal column
    // becomes part of the contract.
    expect(Object.keys(LedgerAccountView.shape)).not.toContain("id");
    expect(Object.keys(LedgerTransactionView.shape)).not.toContain("id");
    // And an entry does not repeat the owner the route already named.
    expect(Object.keys(LedgerTransactionView.shape)).not.toContain("userId");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(LedgerAccountsResponse, { accounts: [accountView(ACCOUNT)], nextCursor: null });
    accepts(LedgerAccountsResponse, { accounts: [], nextCursor: "eyJpZCI6MX0" });
    // An empty list is the honest answer for a player who holds nothing, so the schema must accept it.
    accepts(LedgerUserAccountsResponse, { userId: "u-2", accounts: [] });
    accepts(LedgerUserAccountsResponse, { userId: "u-1", accounts: [accountView(ACCOUNT)] });
    accepts(LedgerTransactionsResponse, {
      userId: "u-1",
      currency: "chips",
      transactions: [transactionView(ENTRY)],
      nextCursor: null,
    });
  });

  test("`available` is computed, not echoed", () => {
    expect(accountView(ACCOUNT).available).toBe(1_000);
  });
});
