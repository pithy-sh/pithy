// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { credentialFields } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { ledger } from "../capability";
import { openLedger } from "../ledger";
import { ledger_0001_accounts } from "../migrations/0001_accounts";
import { LEDGER_PURGE_SUMMARY, ledgerUserPurge } from "./contribution";

/**
 * Ledger's part of a person's purge and export (#814), over real D1: every balance, entry and hold the person
 * holds is exported, then erased, and nobody else's row is touched.
 */

const context = (id: string) => ({ subject: { type: "user" as const, id }, env: { DB: env.DB } });
/** The contribution's export, which every kit contribution declares. */
async function exportOf(input: ReturnType<typeof context>): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

const purge = ledgerUserPurge();

async function count(table: string, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const t of ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  const book = openLedger(env.DB, () => 1_700_000_000_000);
  await book.credit("ada", "chips", 100, "c1", { memo: "welcome" });
  await book.debit("ada", "chips", 30, "d1");
  await book.hold("ada", "chips", 20, "h1");
  await book.credit("bob", "chips", 50, "c2");
});

describe("the ledger user purge", () => {
  test("ledger() declares it for the user subject, with a summary and an export", () => {
    const declared = ledger({ currencies: [{ code: "chips", name: "Chips" }] }).purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(LEDGER_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports every balance, entry and hold the person holds, and nobody else's", async () => {
    const data = await exportOf(context("ada"));
    expect(data.accounts).toEqual([
      expect.objectContaining({ userId: "ada", currency: "chips", balance: 70, held: 20 }),
    ]);
    expect((data.transactions as { ref: string }[]).map((entry) => entry.ref).sort()).toEqual(
      expect.arrayContaining(["c1", "d1"]),
    );
    expect(data.holds).toEqual([expect.objectContaining({ ref: "h1", amount: 20, status: "open" })]);
    expect(JSON.stringify(data)).not.toContain("bob");
    expect(credentialFields(data)).toEqual([]);
  });

  test("erases them, and leaves everyone else's", async () => {
    await purge.erase(context("ada"));
    for (const table of ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"]) {
      expect(await count(table, "ada")).toBe(0);
    }
    expect(await count("pithy_ledger_accounts", "bob")).toBe(1);
    expect(await exportOf(context("ada"))).toEqual({ accounts: [], transactions: [], holds: [] });
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada"));
    await expect(purge.erase(context("ada"))).resolves.toBeUndefined();
  });
});
