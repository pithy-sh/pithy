// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { ledgerAccountId, openPaymentsLedger } from "./ledgerSeam";

/**
 * The one place payments reaches another capability. What matters here is not that the import works — it is
 * what happens when it does not, because that is the difference between a project that is told its catalog
 * needs a package and one whose coin packs quietly stop crediting.
 */

/** Enough of a D1 binding for Kysely to be constructed against. Nothing here executes a query. */
const d1 = {} as D1Database;

/** The refusal a failing loader produces, as the payload-carrying error it must be. */
async function refusal(cause: Error): Promise<PithyError> {
  try {
    await openPaymentsLedger(d1, { load: () => Promise.reject(cause) });
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("the seam did not refuse");
}

describe("openPaymentsLedger", () => {
  test("resolves the real @pithy-sh/ledger through the guarded import", async () => {
    const ledger = await openPaymentsLedger(d1);
    expect(typeof ledger.credit).toBe("function");
    expect(typeof ledger.debit).toBe("function");
  });

  test("an absent ledger is a wiring failure with a named fix, not a silent skip", async () => {
    const error = await refusal(new Error("Cannot find package '@pithy-sh/ledger'"));
    expect(error.payload.code).toBe("core/internal");
    // The action must name the package and the config clause that asked for it — an operator reading this
    // has a catalog with a `grants` block and no idea which package supplies it.
    expect(error.payload.action).toContain("@pithy-sh/ledger");
    expect(error.payload.action).toContain("grants");
  });

  test("the loader's own failure travels as the cause, so the module error survives", async () => {
    const cause = new Error("resolution exploded");
    const error = await refusal(cause);
    expect(error.cause).toBe(cause);
    expect(error.payload.detail).toContain("resolution exploded");
  });
});

/**
 * The other half of the seam: which account a credit lands in.
 *
 * The ledger's id namespace is flat, and nothing in the kit keeps a user id and an organization id apart. So
 * the tests below are about one thing — that a subject's two halves both reach the ledger, and reach it the
 * same way every time.
 */
const EXAMPLE_USER_ID = "usr_01HQZX";

describe("ledgerAccountId", () => {
  test("a user's account is the bare user id — the address @pithy-sh/ledger already reads", () => {
    // Not `user:ada`. Ledger addresses accounts by user id on every read it owns: the authenticated
    // balance route, the `:userId` management segment, its seeds. A grant credited to `user:ada` lands in
    // an account nothing reads, and the player's balance stays empty with no error on either side.
    expect(ledgerAccountId({ subjectType: "user", subjectId: "ada" })).toBe("ada");
  });

  test("an organization is refused, because a per-user ledger has no account for one", () => {
    // Unreachable through composition — `checkLedgerGrants` refuses the catalog at assembly — so this is the
    // backstop. Throwing beats encoding: the alternative is a row in `pithy_ledger_accounts` whose `userId`
    // is not a user, invisible to every route the ledger serves and indistinguishable from an unfunded one.
    expect(() => ledgerAccountId({ subjectType: "organization", subjectId: "ada" })).toThrow(PithyError);
  });

  test("a user id sharing its spelling with an organization is still just that user's account", () => {
    // There is no collision to design around, because an organization never gets an account at all. What
    // matters is that the user's address is untouched by the existence of the other holder kind.
    expect(ledgerAccountId({ subjectType: "user", subjectId: "acme" })).toBe("acme");
  });

  test("takes the pair as one object, so a purchase row is passed whole", () => {
    // A purchase carries both columns and nothing else is needed, which is what keeps a type from config from
    // ever being paired with an id from a row.
    const purchase = { subjectType: "user", subjectId: "grace", productId: "coins_100" } as const;
    expect(ledgerAccountId(purchase)).toBe("grace");
  });

  test("a payments grant lands where @pithy-sh/ledger's own player route reads", () => {
    // The property the asymmetry exists for, stated as itself: under per-person billing the address
    // payments credits and the address ledger reads are the same string, so the two capabilities agree
    // about one balance. Each was internally consistent while they disagreed, which is why no test in
    // either package caught it.
    expect(ledgerAccountId({ subjectType: "user", subjectId: EXAMPLE_USER_ID })).toBe(EXAMPLE_USER_ID);
  });
});
