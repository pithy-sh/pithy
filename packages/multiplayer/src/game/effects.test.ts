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

  describe("a release whose hold is gone (#820)", () => {
    const RELEASE: LedgerEffect = { op: "release", ref: "s1:ada:bet" };
    /** A ledger whose `release` throws `failure`, and records every other call. */
    function failingRelease(failure: unknown, calls: string[] = []) {
      return {
        openLedger: () =>
          ({
            release: async () => {
              throw failure;
            },
            hold: async (userId: string) => void calls.push(`hold:${userId}`),
          }) as never,
      };
    }
    const missing = () =>
      new PithyError({ code: "ledger/hold_not_found", status: 404, message: "That hold does not exist." });

    test("fails by default: a move that releases a hold it never took is a bug, not a settlement", async () => {
      await expect(applyLedgerEffects(d1, [RELEASE], failingRelease(missing()))).rejects.toThrow(/does not exist/);
    });

    test("is settled when settling a seat out, and the effects after it still run", async () => {
      const calls: string[] = [];
      await applyLedgerEffects(d1, [RELEASE, HOLD], failingRelease(missing(), calls), { settlingOut: true });
      expect(calls).toEqual(["hold:alice"]);
    });

    test("anything else a release throws still fails, settling out or not", async () => {
      const notOpen = new PithyError({ code: "ledger/hold_not_open", status: 409, message: "That hold is not open." });
      await expect(applyLedgerEffects(d1, [RELEASE], failingRelease(notOpen), { settlingOut: true })).rejects.toBe(
        notOpen,
      );
      const outage = new Error("D1 is down");
      await expect(applyLedgerEffects(d1, [RELEASE], failingRelease(outage), { settlingOut: true })).rejects.toBe(
        outage,
      );
    });
  });
});
