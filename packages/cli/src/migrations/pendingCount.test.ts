// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { establishedPending } from "./pendingCount";
import type { ProjectLedger } from "./run";

/**
 * **One pending count for every reporter (#697).** `doctor`, `add`, `upgrade` and `deploy` each turned a ledger
 * into a number by hand, and one of them read an unread ledger as zero. This is the table they now share.
 */
describe("establishedPending", () => {
  const cases: [string, ProjectLedger, number | undefined][] = [
    ["a whole read is its count", { state: "read", pending: 3, undeclared: [] }, 3],
    ["a whole read with nothing pending is zero", { state: "read", pending: 0, undeclared: [] }, 0],
    [
      "a partial read is the count over what answered",
      {
        state: "partial",
        counted: { pending: 2, undeclared: [] },
        unreadable: [{ database: "app", binding: "DB" }],
      },
      2,
    ],
    ["an unavailable ledger established nothing, which is not zero", { state: "unavailable" }, undefined],
  ];

  test.each(cases)("%s", (_name, ledger, expected) => {
    expect(establishedPending(ledger)).toBe(expected);
  });
});
