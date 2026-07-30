import type { D1Database } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { openPaymentsLedger } from "./ledgerSeam";

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
