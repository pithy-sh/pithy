// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { rowsBehind } from "./stats";

describe("rowsBehind", () => {
  test("counts every row sealed below the newest version, across tables and names", () => {
    expect(
      rowsBehind({
        newestKeyVersion: 4,
        tables: [
          { table: "a", keys: ["k"], secrets: [{ name: "X", rows: 13, keyVersions: { "3": 12, "4": 1 } }] },
          { table: "b", keys: ["k"], secrets: [{ name: "Y", rows: 3, keyVersions: { "2": 1, "4": 2 } }] },
        ],
      }),
    ).toBe(13);
  });

  test("a vault on one version, and an empty vault, have nothing behind", () => {
    expect(
      rowsBehind({
        newestKeyVersion: 4,
        tables: [{ table: "a", keys: ["k"], secrets: [{ name: "X", rows: 2, keyVersions: { "4": 2 } }] }],
      }),
    ).toBe(0);
    expect(rowsBehind({ newestKeyVersion: null, tables: [] })).toBe(0);
  });
});
