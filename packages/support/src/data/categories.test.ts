// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SupportInvalidCategoryError } from "../error/errors";
import {
  categoryEnum,
  DEFAULT_SUPPORT_CATEGORIES,
  defineSupportCategories,
  describeCategories,
  resolveCategories,
  type SupportCategories,
} from "./categories";
import { UNCATEGORIZED } from "./enums";

/** The key shape the module documents, restated here so a loosened regex fails a test rather than passing one. */
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** The documented description bound. Every description ships in every classification prompt. */
const MAX_DESCRIPTION = 200;

/** Run `fn`, and return the `SupportInvalidCategoryError` it threw. Fails loudly if it threw nothing. */
function invalidCategory(fn: () => unknown): SupportInvalidCategoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SupportInvalidCategoryError) return error;
    throw error;
  }
  throw new Error("expected SupportInvalidCategoryError, nothing was thrown");
}

describe("DEFAULT_SUPPORT_CATEGORIES", () => {
  test("every shipped key is lowercase snake_case", () => {
    for (const key of Object.keys(DEFAULT_SUPPORT_CATEGORIES)) {
      expect(key, key).toMatch(SNAKE_CASE);
    }
  });

  test("every shipped description is a real sentence, and short enough to sit in a prompt", () => {
    for (const [key, description] of Object.entries(DEFAULT_SUPPORT_CATEGORIES)) {
      expect(description.trim().length, key).toBeGreaterThan(0);
      expect(description.length, key).toBeLessThanOrEqual(MAX_DESCRIPTION);
    }
  });

  test("the shipped set passes the validator an adopter's set has to pass", () => {
    // The defaults are declared as a literal and never routed through `defineSupportCategories`, so
    // nothing else in the package would catch a shipped key or description that broke the contract.
    expect(() => defineSupportCategories(DEFAULT_SUPPORT_CATEGORIES)).not.toThrow();
  });

  test("carries `uncategorized` — the documented landing place for an answer nobody can place", () => {
    expect(DEFAULT_SUPPORT_CATEGORIES).toHaveProperty(UNCATEGORIZED);
    expect(Object.keys(DEFAULT_SUPPORT_CATEGORIES).at(-1)).toBe(UNCATEGORIZED);
  });
});

describe("defineSupportCategories", () => {
  test("rejects a key that is not snake_case, and names the key that broke it", () => {
    // The key lands in a filter and in a prompt. A silent pass here is a filter that matches nothing.
    for (const key of ["Billing", "1billing", "bug-report"]) {
      const error = invalidCategory(() => defineSupportCategories({ [key]: "A perfectly fine description." }));
      expect(error.payload.code, key).toBe("support/invalid_category");
      expect(error.payload.status, key).toBe(400);
      expect(error.message, key).toContain(key);
    }
  });

  test("rejects an empty description, whitespace included, and names the category", () => {
    const error = invalidCategory(() => defineSupportCategories({ tournament_dispute: "   \n  " }));
    expect(error.payload.code).toBe("support/invalid_category");
    expect(error.message).toContain("tournament_dispute");
  });

  test("rejects a description over the 200-character bound, and accepts one exactly at it", () => {
    // The bound is the whole reason the prompt stays affordable — off-by-one here is a silent regression.
    expect(() => defineSupportCategories({ tournament_dispute: "x".repeat(MAX_DESCRIPTION) })).not.toThrow();
    const error = invalidCategory(() => defineSupportCategories({ tournament_dispute: "x".repeat(201) }));
    expect(error.payload.code).toBe("support/invalid_category");
    expect(error.message).toContain("tournament_dispute");
  });

  test("returns the same object it was given, so the declaration site keeps its literal types", () => {
    const declared = {
      tournament_dispute: "The sender is contesting a tournament result, a disqualification, or a prize.",
    };
    expect(defineSupportCategories(declared)).toBe(declared);
  });
});

describe("resolveCategories", () => {
  test("with nothing added, the effective taxonomy is exactly the shipped one", () => {
    expect(resolveCategories()).toEqual({ ...DEFAULT_SUPPORT_CATEGORIES });
  });

  test("adds the adopter's categories alongside the shipped ones", () => {
    const resolved = resolveCategories({ tournament_dispute: "The sender is contesting a tournament result." });
    expect(Object.keys(resolved)).toHaveLength(Object.keys(DEFAULT_SUPPORT_CATEGORIES).length + 1);
    expect(resolved.tournament_dispute).toBe("The sender is contesting a tournament result.");
    expect(resolved.billing).toBe(DEFAULT_SUPPORT_CATEGORIES.billing);
  });

  test("the adopter wins on a collision — a shipped description can be reworded for their product", () => {
    const resolved = resolveCategories({ billing: "Anything about coins, gems, or the season pass." });
    expect(resolved.billing).toBe("Anything about coins, gems, or the season pass.");
    // Overriding rewords a category; it must never quietly add a second one under the same name.
    expect(Object.keys(resolved)).toHaveLength(Object.keys(DEFAULT_SUPPORT_CATEGORIES).length);
  });

  test("validates what the adopter passes, so a bad key fails at composition rather than at classify time", () => {
    const error = invalidCategory(() => resolveCategories({ "Tournament-Dispute": "Contesting a result." }));
    expect(error.payload.code).toBe("support/invalid_category");
    expect(error.message).toContain("Tournament-Dispute");
  });
});

describe("categoryEnum", () => {
  test("accepts every key of the effective taxonomy, the adopter's included", () => {
    const categories = resolveCategories({ tournament_dispute: "The sender is contesting a tournament result." });
    const schema = categoryEnum(categories);
    for (const key of Object.keys(categories)) {
      expect(schema.safeParse(key).success, key).toBe(true);
    }
  });

  test("rejects a label nobody declared — the one place an invented answer is caught", () => {
    // A text model always returns *a* label. A plausible invented one would poison every filter
    // downstream, so it has to fail parsing before anything is written.
    const schema = categoryEnum(resolveCategories());
    expect(schema.safeParse("refund_pending").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("BILLING").success).toBe(false);
  });

  test("is built from the taxonomy it is handed, not from the shipped defaults", () => {
    const schema = categoryEnum({ only_this: "The only category this project declares." });
    expect(schema.safeParse("only_this").success).toBe(true);
    expect(schema.safeParse("billing").success).toBe(false);
  });
});

describe("describeCategories", () => {
  test("renders one `- key: description` line per category, in declaration order", () => {
    // Declaration order, not sorted: the prompt has to read the same way every run.
    const categories: SupportCategories = { zebra: "Declared first.", apple: "Declared second." };
    expect(describeCategories(categories)).toBe("- zebra: Declared first.\n- apple: Declared second.");
  });

  test("covers the whole effective taxonomy — a category missing from the prompt can never be picked", () => {
    const categories = resolveCategories({ tournament_dispute: "The sender is contesting a tournament result." });
    const lines = describeCategories(categories).split("\n");
    expect(lines).toHaveLength(Object.keys(categories).length);
    expect(lines.at(-1)).toBe("- tournament_dispute: The sender is contesting a tournament result.");
    expect(lines[0]).toBe(`- billing: ${DEFAULT_SUPPORT_CATEGORIES.billing}`);
  });

  test("renders nothing for an empty taxonomy rather than a stray bullet", () => {
    expect(describeCategories({})).toBe("");
  });
});
