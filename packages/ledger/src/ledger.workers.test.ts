// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { openLedger } from "./ledger";
import { ledger_0001_accounts } from "./migrations/0001_accounts";

const open = () => openLedger(env.DB, () => 1_700_000_000_000);

beforeEach(async () => {
  for (const t of ["pithy_ledger_accounts", "pithy_ledger_transactions", "pithy_ledger_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await ledger_0001_accounts.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const code = (e: unknown) => (e as PithyError).payload.code;

describe("credit and debit", () => {
  test("credit opens an account and adds funds; debit removes them", async () => {
    const ledger = open();
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
    await ledger.credit("alice", "chips", 100, "c1");
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    await ledger.debit("alice", "chips", 30, "d1");
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 70, held: 0, available: 70 });
  });

  test("a debit past the balance is rejected and moves nothing", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 50, "c1");
    try {
      await ledger.debit("alice", "chips", 80, "d1");
      throw new Error("expected throw");
    } catch (e) {
      expect(code(e)).toBe("ledger/insufficient_funds");
    }
    expect((await ledger.balance("alice", "chips")).balance).toBe(50); // untouched
  });

  test("a debit on an unopened account is insufficient funds, not a phantom account", async () => {
    await expect(open().debit("nobody", "chips", 1, "d1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds" },
    });
    expect(await open().balance("nobody", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
  });

  test("amounts must be positive integers", async () => {
    const ledger = open();
    await expect(ledger.credit("alice", "chips", 0, "c1")).rejects.toMatchObject({
      payload: { code: "ledger/invalid_amount" },
    });
    await expect(ledger.credit("alice", "chips", -5, "c2")).rejects.toMatchObject({
      payload: { code: "ledger/invalid_amount" },
    });
    await expect(ledger.credit("alice", "chips", 1.5, "c3")).rejects.toMatchObject({
      payload: { code: "ledger/invalid_amount" },
    });
  });
});

describe("idempotency", () => {
  test("replaying a credit with the same ref applies it once", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "grant-1");
    await ledger.credit("alice", "chips", 100, "grant-1"); // same ref → no-op
    expect((await ledger.balance("alice", "chips")).balance).toBe(100);
  });

  test("replaying a debit with the same ref applies it once", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.debit("alice", "chips", 40, "bet-1");
    await ledger.debit("alice", "chips", 40, "bet-1"); // same ref → no-op
    expect((await ledger.balance("alice", "chips")).balance).toBe(60);
  });
});

describe("transfer", () => {
  test("moves funds atomically between two players", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.transfer("alice", "bob", "chips", 30, "t1");
    expect((await ledger.balance("alice", "chips")).balance).toBe(70);
    expect((await ledger.balance("bob", "chips")).balance).toBe(30);
  });

  test("an overdrawn transfer moves nothing (atomic)", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 10, "c1");
    await expect(ledger.transfer("alice", "bob", "chips", 50, "t1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds" },
    });
    expect((await ledger.balance("alice", "chips")).balance).toBe(10); // unchanged
    expect((await ledger.balance("bob", "chips")).balance).toBe(0); // never credited
  });

  test("a replayed transfer moves funds once", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.transfer("alice", "bob", "chips", 30, "t1");
    await ledger.transfer("alice", "bob", "chips", 30, "t1"); // same ref → no-op
    expect((await ledger.balance("alice", "chips")).balance).toBe(70);
    expect((await ledger.balance("bob", "chips")).balance).toBe(30);
  });
});

describe("holds (escrow for wagers)", () => {
  test("a hold reserves funds — balance unchanged, available drops", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 40, available: 60 });
  });

  test("a hold cannot reserve more than the available balance", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 30, "c1");
    await expect(ledger.hold("alice", "chips", 50, "bet-1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds" },
    });
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 30, held: 0, available: 30 });
  });

  test("two holds cannot together exceed the balance", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 70, "bet-1");
    await expect(ledger.hold("alice", "chips", 40, "bet-2")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds" },
    });
    expect((await ledger.balance("alice", "chips")).held).toBe(70);
  });

  test("releasing a hold returns the funds", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.release("bet-1");
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
  });

  test("capturing a hold spends it (a lost wager)", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.capture("bet-1"); // captures the full 40
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 60, held: 0, available: 60 });
  });

  test("a partial capture spends part and returns the rest", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.capture("bet-1", { amount: 25 });
    // 25 spent, 15 returned to available; balance 75, nothing held.
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 75, held: 0, available: 75 });
  });

  test("a hold can be resolved only once", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.capture("bet-1");
    await expect(ledger.release("bet-1")).rejects.toMatchObject({ payload: { code: "ledger/hold_not_open" } });
    await expect(ledger.capture("bet-1")).rejects.toMatchObject({ payload: { code: "ledger/hold_not_open" } });
    expect((await ledger.balance("alice", "chips")).balance).toBe(60); // still just the one capture
  });

  test("releasing an unknown hold is a 404", async () => {
    await expect(open().release("nope")).rejects.toMatchObject({ payload: { code: "ledger/hold_not_found" } });
  });

  test("held funds cannot be spent by a debit", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 80, "bet-1");
    // available is only 20; a 50 debit must fail.
    await expect(ledger.debit("alice", "chips", 50, "d1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds" },
    });
    await ledger.debit("alice", "chips", 20, "d2"); // exactly available is fine
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 80, held: 80, available: 0 });
  });
});
