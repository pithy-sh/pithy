// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { assertRollbackConfirmed, rollbackConfirmPhrase } from "./confirm";

/**
 * **The rollback phrase is a person's to give (#697).**
 *
 * Missing or mistyped, the refusal is `core/person_required` — exit 5 — so an agent stops and asks rather
 * than trying variations. The action line names `--confirm-rollback` and the phrase, for the person.
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
  test("no phrase needs a person, and the action names --confirm-rollback", () => {
    expect(payloadOf(() => assertRollbackConfirmed("staging", undefined))).toMatchObject({
      code: "core/person_required",
      message: "Rolling back staging reverses a group of migrations in every database it binds.",
      action: `Pass --confirm-rollback "${rollbackConfirmPhrase("staging")}" to roll back staging.`,
    });
  });

  test("a wrong phrase needs a person too", () => {
    const payload = payloadOf(() => assertRollbackConfirmed("staging", "yes"));
    expect(payload).toMatchObject({
      code: "core/person_required",
      message: "That is not the confirmation phrase for rolling back staging.",
      action: `Pass --confirm-rollback "${rollbackConfirmPhrase("staging")}" to roll back staging.`,
    });
  });

  test("a phrase for another environment does not unlock this one", () => {
    expect(payloadOf(() => assertRollbackConfirmed("prod", rollbackConfirmPhrase("staging"))).code).toBe(
      "core/person_required",
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
