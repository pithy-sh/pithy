// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { encodeCursor } from "@pithy-sh/core/src/data/cursor";
import { describe, expect, test } from "vitest";
import { entryCursor, resumeAfter } from "./read";

/**
 * The management listing's cursor: the score in `sort`, and both tiebreaks in `id`. A position the
 * cursor cannot carry exactly is a row a page boundary skips or repeats.
 */
describe("the entry cursor", () => {
  test("round-trips a position, a user id with colons in it included", () => {
    const entry = { score: 42.5, achievedAt: new Date(1_700_000_000_000), userId: "auth0|abc:def" };
    expect(resumeAfter(encodeCursor(entryCursor(entry)))).toEqual({
      score: 42.5,
      achievedAt: 1_700_000_000_000,
      userId: "auth0|abc:def",
    });
  });

  test("a missing cursor is a first page", () => {
    expect(resumeAfter(undefined)).toBeUndefined();
  });

  test("a cursor that is not one of ours is a first page, never an error", () => {
    for (const foreign of [
      "not-base64-json",
      encodeCursor({ sort: 3, id: 7 }),
      encodeCursor({ sort: "2026-01-01", id: "1:u1" }),
      encodeCursor({ sort: 3, id: "no-separator" }),
      encodeCursor({ sort: 3, id: ":u1" }),
      encodeCursor({ sort: 3, id: "soon:u1" }),
    ]) {
      expect(resumeAfter(foreign), foreign).toBeUndefined();
    }
  });
});
