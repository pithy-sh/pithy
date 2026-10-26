// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { openLedger, openLedgerWrites } from "./ledger";
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

/** Every entry on one account, oldest first, as the raw log holds it. */
async function entries(userId: string, currency: string) {
  const rows = await open().transactions(userId, currency, 100);
  return rows
    .reverse()
    .map((row) => ({ ref: row.ref, kind: row.kind, amount: row.amount, relatedRef: row.relatedRef, memo: row.memo }));
}

describe("reverse", () => {
  test("reversing a credit posts a debit against it, and leaves the original as it was", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "grant-1", { memo: "welcome" });
    expect(await ledger.reverse("grant-1", { memo: "granted twice" })).toEqual({ balance: 0, held: 0, available: 0 });
    expect(await entries("alice", "chips")).toEqual([
      { ref: "grant-1", kind: "credit", amount: 100, relatedRef: null, memo: "welcome" },
      { ref: "grant-1:reverse", kind: "debit", amount: 100, relatedRef: "grant-1", memo: "granted twice" },
    ]);
  });

  test("reversing a debit posts a credit against it", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.debit("alice", "chips", 30, "d1");
    expect(await ledger.reverse("d1")).toEqual({ balance: 100, held: 0, available: 100 });
    expect((await entries("alice", "chips")).at(-1)).toEqual({
      ref: "d1:reverse",
      kind: "credit",
      amount: 30,
      relatedRef: "d1",
      memo: null,
    });
  });

  test("a second reversal of the same entry moves nothing", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.debit("alice", "chips", 30, "d1");
    await ledger.reverse("d1");
    expect(await ledger.reverse("d1")).toEqual({ balance: 100, held: 0, available: 100 });
    expect((await entries("alice", "chips")).filter((e) => e.ref === "d1:reverse")).toHaveLength(1);
  });

  test("two reversals in flight at once move the balance once", async () => {
    // The unique `:reverse` ref is the guard, not a read: both calls read the original, both try to post,
    // and the database lets exactly one in.
    const writes = openLedgerWrites(env.DB);
    await open().credit("alice", "chips", 100, "c1");
    await open().debit("alice", "chips", 30, "d1");
    const both = await Promise.all([writes.reverse("d1"), writes.reverse("d1")]);
    expect(both.map((outcome) => outcome.applied).sort()).toEqual([false, true]);
    expect(await open().balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
    expect((await entries("alice", "chips")).filter((e) => e.ref === "d1:reverse")).toHaveLength(1);
  });

  test("an unknown entry is not found", async () => {
    await expect(open().reverse("nope")).rejects.toMatchObject({ payload: { code: "ledger/entry_not_found" } });
  });

  test("only a credit or a debit reverses, and the refusal names the kind", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 10, "h1");
    await ledger.hold("alice", "chips", 10, "h2");
    await ledger.release("h1");
    await ledger.capture("h2");
    await ledger.transfer("alice", "bob", "chips", 5, "t1");
    for (const [ref, kind] of [
      ["h1", "hold"],
      ["h1:resolve", "release"],
      ["h2:resolve", "capture"],
      ["t1:out", "transfer_out"],
      ["t1:in", "transfer_in"],
    ] as const) {
      await expect(ledger.reverse(ref), ref).rejects.toMatchObject({
        payload: { code: "ledger/entry_not_reversible", params: { kind } },
      });
    }
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 85, held: 0, available: 85 });
  });

  test("a reversal of a reversal is refused", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.debit("alice", "chips", 30, "d1");
    await ledger.reverse("d1");
    await expect(ledger.reverse("d1:reverse")).rejects.toMatchObject({
      payload: { code: "ledger/entry_not_reversible", params: { kind: "credit", reverses: "d1" } },
    });
    expect((await ledger.balance("alice", "chips")).balance).toBe(100);
  });

  test("reversing a credit that has been spent is refused, naming the shortfall, and writes nothing", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 70, "h1");
    // available is 30; taking back the 100 would leave the account 70 short.
    await expect(ledger.reverse("c1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds", params: { amount: 100, available: 30, shortfall: 70 } },
    });
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 70, available: 30 });
    expect((await entries("alice", "chips")).map((e) => e.ref)).toEqual(["c1", "h1"]);
  });
});

describe("a debit refusal names the shortfall", () => {
  test("the shortfall is what the debit asked for past what was available", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 50, "c1");
    await ledger.hold("alice", "chips", 20, "h1");
    await expect(ledger.debit("alice", "chips", 45, "d1")).rejects.toMatchObject({
      payload: { code: "ledger/insufficient_funds", params: { amount: 45, available: 30, shortfall: 15 } },
    });
  });
});

describe("release with a memo", () => {
  test("the memo lands on the release entry", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.release("bet-1", { memo: "table crashed" });
    expect((await entries("alice", "chips")).at(-1)).toEqual({
      ref: "bet-1:resolve",
      kind: "release",
      amount: 40,
      relatedRef: "bet-1",
      memo: "table crashed",
    });
  });

  test("without one the entry carries none, as before", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "bet-1");
    await ledger.release("bet-1");
    expect((await entries("alice", "chips")).at(-1)?.memo).toBeNull();
  });
});

/**
 * An entry written straight into the log, the way a release before reserved refs were refused could have
 * left one: a client's credit whose ref happens to be another entry's derived ref.
 */
async function legacyEntry(ref: string, userId: string, currency: string, kind: string, amount: number) {
  await env.DB.prepare(
    "INSERT INTO pithy_ledger_transactions (ref, user_id, currency, kind, amount, related_ref, memo, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)",
  )
    .bind(ref, userId, currency, kind, amount)
    .run();
}

describe("the refs the ledger derives are its own", () => {
  test.each([":reverse", ":resolve", ":out", ":in"])(
    "in process, a credit, a debit or a hold whose ref ends in %s is the caller's, as it always was",
    async (suffix) => {
      // Only the control-plane request schema refuses these. A game model's `${session}:buy:in`, or payments'
      // `payments:grant:p-1:in` for a currency coded `in`, still writes — and replays as a no-op.
      const ledger = open();
      const ref = `s1:alice${suffix}`;
      await ledger.credit("alice", "chips", 100, ref);
      await ledger.credit("alice", "chips", 100, ref);
      await ledger.debit("alice", "chips", 10, `d1${suffix}`);
      await ledger.hold("alice", "chips", 10, `h1${suffix}`);
      expect(await ledger.balance("alice", "chips")).toEqual({ balance: 90, held: 10, available: 80 });
    },
  );

  test("a ref with a colon anywhere else is still the caller's", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "payments:grant:p-1:chips");
    await ledger.debit("alice", "chips", 10, "game:round-3:reverse-bet");
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 90, held: 0, available: 90 });
  });

  test("a reversal whose ref another entry already holds is a conflict, never a replay", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "refund-7");
    await legacyEntry("refund-7:reverse", "bob", "chips", "credit", 10);
    await expect(openLedgerWrites(env.DB).reverse("refund-7")).rejects.toMatchObject({
      payload: { code: "ledger/ref_conflict" },
    });
    await expect(ledger.reverse("refund-7")).rejects.toMatchObject({ payload: { code: "ledger/ref_conflict" } });
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
  });

  test("a release or a capture whose ref another entry already holds is a conflict, and the hold stays open", async () => {
    const ledger = open();
    await ledger.credit("alice", "chips", 100, "c1");
    await ledger.hold("alice", "chips", 40, "H");
    await legacyEntry("H:resolve", "bob", "chips", "credit", 10);
    await expect(openLedgerWrites(env.DB).release("H")).rejects.toMatchObject({
      payload: { code: "ledger/ref_conflict" },
    });
    await expect(ledger.release("H")).rejects.toMatchObject({ payload: { code: "ledger/ref_conflict" } });
    await expect(ledger.capture("H")).rejects.toMatchObject({ payload: { code: "ledger/ref_conflict" } });
    expect(await ledger.balance("alice", "chips")).toEqual({ balance: 100, held: 40, available: 60 });
  });
});

describe("openLedgerWrites: what each write did", () => {
  const writes = () => openLedgerWrites(env.DB, () => 1_700_000_000_000);

  test("a credit reports the account either side of it", async () => {
    await open().credit("alice", "chips", 10, "c0");
    expect(await writes().credit("alice", "chips", 25, "c1")).toEqual({
      applied: true,
      before: { balance: 10, held: 0, available: 10 },
      after: { balance: 35, held: 0, available: 35 },
    });
  });

  test("a replay reports nothing applied, and the current balance on both sides", async () => {
    await writes().credit("alice", "chips", 25, "c1");
    expect(await writes().credit("alice", "chips", 25, "c1")).toEqual({
      applied: false,
      before: { balance: 25, held: 0, available: 25 },
      after: { balance: 25, held: 0, available: 25 },
    });
  });

  test("a debit reports the account either side of it", async () => {
    await open().credit("alice", "chips", 100, "c0");
    await open().hold("alice", "chips", 10, "h0");
    expect(await writes().debit("alice", "chips", 30, "d1")).toEqual({
      applied: true,
      before: { balance: 100, held: 10, available: 90 },
      after: { balance: 70, held: 10, available: 60 },
    });
  });

  test("a reversal reports the entry it reversed", async () => {
    await open().credit("alice", "chips", 100, "c1");
    expect(await writes().reverse("c1")).toEqual({
      applied: true,
      before: { balance: 100, held: 0, available: 100 },
      after: { balance: 0, held: 0, available: 0 },
      entry: { ref: "c1", userId: "alice", currency: "chips", kind: "credit", amount: 100 },
    });
  });

  test("a reversal scoped to an account refuses an entry on another as not found", async () => {
    await open().credit("bob", "chips", 100, "c1");
    await open().credit("alice", "gold", 100, "g1");
    await expect(writes().reverse("c1", { account: { userId: "alice", currency: "chips" } })).rejects.toMatchObject({
      payload: { code: "ledger/entry_not_found" },
    });
    await expect(writes().reverse("g1", { account: { userId: "alice", currency: "chips" } })).rejects.toMatchObject({
      payload: { code: "ledger/entry_not_found" },
    });
    expect((await open().balance("bob", "chips")).balance).toBe(100);
  });

  test("a release reports the hold it released, and a second is a replay", async () => {
    await open().credit("alice", "chips", 100, "c1");
    await open().hold("alice", "chips", 40, "h1");
    expect(await writes().release("h1", { memo: "stuck" })).toEqual({
      applied: true,
      before: { balance: 100, held: 40, available: 60 },
      after: { balance: 100, held: 0, available: 100 },
      hold: { ref: "h1", userId: "alice", currency: "chips", amount: 40 },
    });
    expect(await writes().release("h1", { memo: "stuck" })).toMatchObject({
      applied: false,
      after: { balance: 100, held: 0, available: 100 },
    });
  });

  test("a release of a captured hold is refused as not open", async () => {
    await open().credit("alice", "chips", 100, "c1");
    await open().hold("alice", "chips", 40, "h1");
    await open().capture("h1");
    await expect(writes().release("h1")).rejects.toMatchObject({ payload: { code: "ledger/hold_not_open" } });
  });

  test("a release of a ref that is no hold is not found", async () => {
    await open().credit("alice", "chips", 100, "c1");
    await expect(writes().release("c1")).rejects.toMatchObject({ payload: { code: "ledger/hold_not_found" } });
  });

  test("a release scoped to an account refuses a hold on another as not found, and releases nothing", async () => {
    await open().credit("bob", "chips", 100, "c1");
    await open().hold("bob", "chips", 40, "h1");
    await open().credit("alice", "gold", 100, "c2");
    await open().hold("alice", "gold", 40, "h2");
    await expect(writes().release("h1", { account: { userId: "alice", currency: "chips" } })).rejects.toMatchObject({
      payload: { code: "ledger/hold_not_found" },
    });
    await expect(writes().release("h2", { account: { userId: "alice", currency: "chips" } })).rejects.toMatchObject({
      payload: { code: "ledger/hold_not_found" },
    });
    expect((await open().balance("bob", "chips")).held).toBe(40);
    expect((await open().balance("alice", "gold")).held).toBe(40);
  });

  test("two releases in flight at once release once", async () => {
    await open().credit("alice", "chips", 100, "c1");
    await open().hold("alice", "chips", 40, "h1");
    const both = await Promise.all([writes().release("h1"), writes().release("h1")]);
    expect(both.map((outcome) => outcome.applied).sort()).toEqual([false, true]);
    expect(await open().balance("alice", "chips")).toEqual({ balance: 100, held: 0, available: 100 });
  });

  test("a release that loses a race to a capture is refused as not open, never answered as released", async () => {
    await open().credit("alice", "chips", 100, "c1");
    await open().hold("alice", "chips", 40, "h1");
    // The release reads the hold open; before its batch runs, game code captures it.
    let raced = false;
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: Parameters<typeof env.DB.batch>[0]) => {
            if (!raced) {
              raced = true;
              await openLedger(env.DB).capture("h1");
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(openLedgerWrites(racing).release("h1", { memo: "stuck" })).rejects.toMatchObject({
      payload: { code: "ledger/hold_not_open" },
    });
    expect(raced).toBe(true);
    expect(await open().balance("alice", "chips")).toEqual({ balance: 60, held: 0, available: 60 });
  });

  test.each([
    ["another account", () => writes().credit("bob", "chips", 100, "refund-7")],
    ["another currency", () => writes().credit("alice", "gold", 100, "refund-7")],
    ["another amount", () => writes().credit("alice", "chips", 50, "refund-7")],
    ["another kind", () => writes().debit("alice", "chips", 100, "refund-7")],
    ["a hold's ref", () => writes().credit("alice", "chips", 100, "h1")],
  ])("a credit or a debit under a ref held by %s is a conflict, never a replay", async (_case, write) => {
    await open().credit("alice", "chips", 100, "refund-7");
    await open().hold("alice", "chips", 10, "h1");
    await expect(write()).rejects.toMatchObject({
      payload: { code: "ledger/ref_conflict", params: { ref: expect.any(String) } },
    });
    expect(await open().balance("alice", "chips")).toEqual({ balance: 100, held: 10, available: 90 });
    expect(await open().balance("bob", "chips")).toEqual({ balance: 0, held: 0, available: 0 });
    expect(await open().balance("alice", "gold")).toEqual({ balance: 0, held: 0, available: 0 });
  });

  test("the same credit or debit under its own ref is a replay, whatever its memo says", async () => {
    await writes().credit("alice", "chips", 100, "c1", { memo: "Refund" });
    await writes().debit("alice", "chips", 30, "d1", { memo: "Clawback" });
    expect(await writes().credit("alice", "chips", 100, "c1", { memo: "Refund, retried" })).toMatchObject({
      applied: false,
    });
    expect(await writes().debit("alice", "chips", 30, "d1")).toMatchObject({ applied: false });
    expect(await open().balance("alice", "chips")).toEqual({ balance: 70, held: 0, available: 70 });
  });

  test("in process, a credit under a ref another write holds is still a no-op, as it always was", async () => {
    await open().credit("alice", "chips", 100, "refund-7");
    expect(await open().credit("bob", "chips", 50, "refund-7")).toEqual({ balance: 0, held: 0, available: 0 });
  });
});
