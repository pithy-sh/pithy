import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { ledger_0001_accounts } from "./0001_accounts";

const db = () => createDatabase(env.DB, {}) as unknown as Kysely<unknown>;

async function catalog(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE 'pithy_ledger_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

beforeEach(async () => {
  for (const t of ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
});

describe("ledger_0001_accounts", () => {
  test("up creates the three tables and the transaction index", async () => {
    await ledger_0001_accounts.up(db());
    expect(await catalog()).toEqual([
      "pithy_ledger_accounts",
      "pithy_ledger_holds",
      "pithy_ledger_transactions",
      "pithy_ledger_transactions_owner_idx",
    ]);
  });

  test("the accounts CHECK constraint rejects a negative balance at the DB level", async () => {
    await ledger_0001_accounts.up(db());
    // A direct insert that violates solvency must be refused by SQLite itself.
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_ledger_accounts (user_id, currency, balance, held, created_at, updated_at) VALUES ('x','chips',-1,0,0,0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
    // held may not exceed balance either.
    await expect(
      env.DB.prepare(
        "INSERT INTO pithy_ledger_accounts (user_id, currency, balance, held, created_at, updated_at) VALUES ('y','chips',10,20,0,0)",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  test("down is the exact inverse and up is re-runnable after it", async () => {
    await ledger_0001_accounts.up(db());
    await ledger_0001_accounts.down?.(db());
    expect(await catalog()).toEqual([]);
    await ledger_0001_accounts.up(db());
    expect(await catalog()).toContain("pithy_ledger_accounts");
  });
});
