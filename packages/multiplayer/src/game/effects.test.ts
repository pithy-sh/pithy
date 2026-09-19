// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { applyLedgerEffects, type LedgerEffect } from "./effects";

/**
 * The ledger reaches a session from the composition, never through an import (#645). What that leaves to test
 * here is the absent case: a game that moves no balance needs no ledger, and one that does refuses without one
 * rather than playing for stakes nobody recorded. The settlement itself runs against the real ledger in
 * `wager.workers.test.ts`.
 */
const d1 = {} as D1Database;
const HOLD: LedgerEffect = { op: "hold", userId: "alice", currency: "chips", amount: 10, ref: "s1:alice:stake" };

describe("applyLedgerEffects", () => {
  test("a game that moves no balance needs no ledger", async () => {
    await expect(applyLedgerEffects(d1, [], undefined)).resolves.toBeUndefined();
  });

  test("a game that moves a balance, with no ledger composed, refuses and names the fix", async () => {
    const refusal = await applyLedgerEffects(d1, [HOLD], undefined).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PithyError);
    expect((refusal as PithyError).payload.action).toContain("ledger(...)");
  });

  test("settles through the ledger it was handed", async () => {
    const calls: string[] = [];
    const ledger = new Proxy(
      {},
      {
        get:
          (_target, op: string) =>
          async (...args: unknown[]) =>
            void calls.push(`${op}:${String(args[0])}`),
      },
    );
    await applyLedgerEffects(d1, [HOLD], { openLedger: () => ledger as never });
    expect(calls).toEqual(["hold:alice"]);
  });
});
