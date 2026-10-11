// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { assertRollbackConfirmed, rollbackConfirmPhrase } from "./confirm";

/**
 * **A missing phrase and a wrong phrase are different failures (#697).**
 *
 * No phrase at all means nobody was asked: the run could not prompt, so it fails `input/required` and
 * names `--confirm-rollback`, the flag that answers it. A wrong phrase is an answer, and it is refused as
 * one — `validation/invalid_input` — because a caller that typed something has nothing left to supply.
 */

/** What a thunk threw, as its payload. Fails the test when it threw something else, or nothing. */
function payloadOf(run: () => void): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload as unknown as Record<string, unknown>;
    throw error;
  }
  throw new Error("expected a PithyError, and nothing was thrown");
}

describe("assertRollbackConfirmed", () => {
  test("no phrase is a question this run could not ask: input/required, naming --confirm-rollback", () => {
    expect(payloadOf(() => assertRollbackConfirmed("staging", undefined))).toMatchObject({
      code: "input/required",
      flag: "--confirm-rollback",
      message: "Rolling back staging reverses a group of migrations in every database it binds.",
      action: `Pass --confirm-rollback "${rollbackConfirmPhrase("staging")}" to roll back staging.`,
    });
  });

  test("a wrong phrase is an answer, refused as invalid input", () => {
    const payload = payloadOf(() => assertRollbackConfirmed("staging", "yes"));
    expect(payload).toMatchObject({
      code: "validation/invalid_input",
      message: "That is not the confirmation phrase for rolling back staging.",
      action: `Pass --confirm-rollback "${rollbackConfirmPhrase("staging")}" to roll back staging.`,
    });
    expect(payload).not.toHaveProperty("flag");
  });

  test("a phrase for another environment does not unlock this one", () => {
    expect(payloadOf(() => assertRollbackConfirmed("prod", rollbackConfirmPhrase("staging"))).code).toBe(
      "validation/invalid_input",
    );
  });

  test("the exact phrase passes, compared after trimming and ignoring case", () => {
    expect(() => assertRollbackConfirmed("staging", rollbackConfirmPhrase("staging"))).not.toThrow();
    expect(() => assertRollbackConfirmed("staging", "  Yes, I Really Want To Roll Back STAGING ")).not.toThrow();
  });

  test("dev needs no phrase at all", () => {
    expect(() => assertRollbackConfirmed("dev", undefined)).not.toThrow();
  });
});
