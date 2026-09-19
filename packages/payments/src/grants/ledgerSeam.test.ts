// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { ledgerPeer } from "@pithy-sh/ledger/src/peer";
import { describe, expect, test } from "vitest";
import { ledgerAccountId, openPaymentsLedger } from "./ledgerSeam";

/**
 * The one place payments reaches another capability. What matters here is not that a ledger opens — it is what
 * happens when none was handed over, because that is the difference between a project that is told its catalog
 * needs a ledger and one whose coin packs quietly stop crediting.
 *
 * Nothing here loads a module. The ledger arrives from the composition (#645), so the absent case is simply an
 * absent peer; the bundler half — that a project without the package can build payments at all — is
 * `workflows/hostBundle.test.ts`, which runs wrangler.
 */

/** Enough of a D1 binding for Kysely to be constructed against. Nothing here executes a query. */
const d1 = {} as D1Database;

/** The refusal an absent peer produces, as the payload-carrying error it must be. */
function refusal(): PithyError {
  try {
    openPaymentsLedger(d1, {});
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("the seam did not refuse");
}

describe("openPaymentsLedger", () => {
  test("opens the ledger through the peer surface @pithy-sh/ledger's capability carries", () => {
    // The real `ledgerPeer`, so the structural `PaymentsLedgerPeer` is held to the ledger's actual shape.
    const ledger = openPaymentsLedger(d1, { peer: ledgerPeer });
    expect(typeof ledger.credit).toBe("function");
    expect(typeof ledger.debit).toBe("function");
  });

  test("hands the clock through to the ledger it opens", () => {
    const seen: (() => number)[] = [];
    const now = () => 42;
    openPaymentsLedger(d1, {
      peer: {
        openLedger: (_d1, clock) => {
          if (clock) seen.push(clock);
          return { credit: async () => undefined, debit: async () => undefined };
        },
      },
      now,
    });
    expect(seen).toEqual([now]);
  });

  test("an absent ledger is a wiring failure with a named fix, not a silent skip", () => {
    const error = refusal();
    expect(error.payload.code).toBe("core/internal");
    // The action must name the capability and the config clause that asked for it — an operator reading this
    // has a catalog with a `grants` block and no idea what supplies it.
    expect(error.payload.action).toContain("ledger(...)");
    expect(error.payload.action).toContain("grants");
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
