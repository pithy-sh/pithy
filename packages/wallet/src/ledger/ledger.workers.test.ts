import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { wallet_0001_ledger } from "../migrations/0001_ledger";
import { ledger } from "./ledger";

const wallet = () => ledger(env.DB, () => 1_700_000_000_000);

beforeEach(async () => {
  for (const t of ["pithy_wallet_accounts", "pithy_wallet_transactions", "pithy_wallet_holds"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await wallet_0001_ledger.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const code = (e: unknown) => (e as PithyError).payload.code;

describe("credit and debit", () => {
  test("credit opens an account and adds funds; debit removes them", async () => {
    const w = wallet();
    expect(await w.balance("alice", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
    await w.credit("alice", "chips", 100, "c1");
    expect(await w.balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    await w.debit("alice", "chips", 30, "d1");
    expect(await w.balance("alice", "chips")).toEqual({ balance: 70, held: 0, available: 70 });
  });

  test("a debit past the balance is rejected and moves nothing", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 50, "c1");
    try {
      await w.debit("alice", "chips", 80, "d1");
      throw new Error("expected throw");
    } catch (e) {
      expect(code(e)).toBe("wallet/insufficient_funds");
    }
    expect((await w.balance("alice", "chips")).balance).toBe(50); // untouched
  });

  test("a debit on an unopened account is insufficient funds, not a phantom account", async () => {
    await expect(wallet().debit("nobody", "chips", 1, "d1")).rejects.toMatchObject({
      payload: { code: "wallet/insufficient_funds" },
    });
    expect(await wallet().balance("nobody", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
  });

  test("amounts must be positive integers", async () => {
    const w = wallet();
    await expect(w.credit("alice", "chips", 0, "c1")).rejects.toMatchObject({
      payload: { code: "wallet/invalid_amount" },
    });
    await expect(w.credit("alice", "chips", -5, "c2")).rejects.toMatchObject({
      payload: { code: "wallet/invalid_amount" },
    });
    await expect(w.credit("alice", "chips", 1.5, "c3")).rejects.toMatchObject({
      payload: { code: "wallet/invalid_amount" },
    });
  });
});

describe("idempotency", () => {
  test("replaying a credit with the same ref applies it once", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "grant-1");
    await w.credit("alice", "chips", 100, "grant-1"); // same ref → no-op
    expect((await w.balance("alice", "chips")).balance).toBe(100);
  });

  test("replaying a debit with the same ref applies it once", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.debit("alice", "chips", 40, "bet-1");
    await w.debit("alice", "chips", 40, "bet-1"); // same ref → no-op
    expect((await w.balance("alice", "chips")).balance).toBe(60);
  });
});

describe("transfer", () => {
  test("moves funds atomically between two players", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.transfer("alice", "bob", "chips", 30, "t1");
    expect((await w.balance("alice", "chips")).balance).toBe(70);
    expect((await w.balance("bob", "chips")).balance).toBe(30);
  });

  test("an overdrawn transfer moves nothing (atomic)", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 10, "c1");
    await expect(w.transfer("alice", "bob", "chips", 50, "t1")).rejects.toMatchObject({
      payload: { code: "wallet/insufficient_funds" },
    });
    expect((await w.balance("alice", "chips")).balance).toBe(10); // unchanged
    expect((await w.balance("bob", "chips")).balance).toBe(0); // never credited
  });

  test("a replayed transfer moves funds once", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.transfer("alice", "bob", "chips", 30, "t1");
    await w.transfer("alice", "bob", "chips", 30, "t1"); // same ref → no-op
    expect((await w.balance("alice", "chips")).balance).toBe(70);
    expect((await w.balance("bob", "chips")).balance).toBe(30);
  });
});

describe("holds (escrow for wagers)", () => {
  test("a hold reserves funds — balance unchanged, available drops", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 40, "bet-1");
    expect(await w.balance("alice", "chips")).toEqual({ balance: 100, held: 40, available: 60 });
  });

  test("a hold cannot reserve more than the available balance", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 30, "c1");
    await expect(w.hold("alice", "chips", 50, "bet-1")).rejects.toMatchObject({
      payload: { code: "wallet/insufficient_funds" },
    });
    expect(await w.balance("alice", "chips")).toEqual({ balance: 30, held: 0, available: 30 });
  });

  test("two holds cannot together exceed the balance", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 70, "bet-1");
    await expect(w.hold("alice", "chips", 40, "bet-2")).rejects.toMatchObject({
      payload: { code: "wallet/insufficient_funds" },
    });
    expect((await w.balance("alice", "chips")).held).toBe(70);
  });

  test("releasing a hold returns the funds", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 40, "bet-1");
    await w.release("bet-1");
    expect(await w.balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
  });

  test("capturing a hold spends it (a lost wager)", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 40, "bet-1");
    await w.capture("bet-1"); // captures the full 40
    expect(await w.balance("alice", "chips")).toEqual({ balance: 60, held: 0, available: 60 });
  });

  test("a partial capture spends part and returns the rest", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 40, "bet-1");
    await w.capture("bet-1", { amount: 25 });
    // 25 spent, 15 returned to available; balance 75, nothing held.
    expect(await w.balance("alice", "chips")).toEqual({ balance: 75, held: 0, available: 75 });
  });

  test("a hold can be resolved only once", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 40, "bet-1");
    await w.capture("bet-1");
    await expect(w.release("bet-1")).rejects.toMatchObject({ payload: { code: "wallet/hold_not_open" } });
    await expect(w.capture("bet-1")).rejects.toMatchObject({ payload: { code: "wallet/hold_not_open" } });
    expect((await w.balance("alice", "chips")).balance).toBe(60); // still just the one capture
  });

  test("releasing an unknown hold is a 404", async () => {
    await expect(wallet().release("nope")).rejects.toMatchObject({ payload: { code: "wallet/hold_not_found" } });
  });

  test("held funds cannot be spent by a debit", async () => {
    const w = wallet();
    await w.credit("alice", "chips", 100, "c1");
    await w.hold("alice", "chips", 80, "bet-1");
    // available is only 20; a 50 debit must fail.
    await expect(w.debit("alice", "chips", 50, "d1")).rejects.toMatchObject({
      payload: { code: "wallet/insufficient_funds" },
    });
    await w.debit("alice", "chips", 20, "d2"); // exactly available is fine
    expect(await w.balance("alice", "chips")).toEqual({ balance: 80, held: 80, available: 0 });
  });
});
