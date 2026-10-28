// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import { describe, expect, test } from "vitest";
import { type LatestChoiceGroup, tallyStandings } from "./standings";

const records = ConsentPurpose.parse({
  id: "clinic.records",
  summary: "Keep my health records.",
  noticeVersion: 2,
  classes: ["phi"],
  minimumMethod: "typed",
});
const catalog = new Map([[records.id, records]]);

const group = (overrides: Partial<LatestChoiceGroup>): LatestChoiceGroup => ({
  purpose: "clinic.records",
  noticeVersion: 2,
  action: "grant",
  method: "typed",
  expired: false,
  lapsed: false,
  subjects: 1,
  ...overrides,
});

describe("tallyStandings", () => {
  test("a purpose nobody has chosen on counts zero, and is still listed", () => {
    expect(tallyStandings(catalog, [])).toEqual([{ purpose: records, grants: 0, withdrawals: 0, standing: 0 }]);
  });

  test("only a current, unexpired grant at the minimum stands; every grant still counts as a grant", () => {
    const [tally] = tallyStandings(catalog, [
      group({ subjects: 3 }),
      group({ noticeVersion: 1 }),
      group({ method: "click" }),
      group({ expired: true }),
      group({ lapsed: true }),
      group({ action: "withdraw", subjects: 2 }),
    ]);
    expect(tally).toMatchObject({ grants: 7, withdrawals: 2, standing: 3 });
  });

  test("leaves out rows for a purpose the catalog no longer holds", () => {
    expect(tallyStandings(catalog, [group({ purpose: "clinic.gone", subjects: 9 })])[0]).toMatchObject({ grants: 0 });
  });
});
