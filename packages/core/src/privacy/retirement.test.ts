// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { guardIsClean, RetirementVerdict, retirementVerdict, versionsDue } from "./retirement";

/**
 * **The retirement guard, directly (#390).** Retiring a version is the one irreversible act in field encryption,
 * and these are the two functions that decide it: which versions are due, and whether anything holds them.
 */

const clean = { stale: 0, coverageComplete: true, unrotatable: 0 };

describe("versionsDue", () => {
  test("is every live version older than the newest two, whatever order it was given in", () => {
    expect(versionsDue([3, 1, 4, 2])).toEqual([2, 1]);
    expect(versionsDue([10, 9, 11])).toEqual([9]);
  });

  test("is nothing at the normal state of current and previous, or fewer", () => {
    expect(versionsDue([2, 1])).toEqual([]);
    expect(versionsDue([1])).toEqual([]);
    expect(versionsDue([])).toEqual([]);
  });

  test("does not reorder the array it was given", () => {
    const versions = [1, 3, 2];
    versionsDue(versions);
    expect(versions).toEqual([1, 3, 2]);
  });
});

describe("retirementVerdict", () => {
  test("is clean, and not blocked, only when all three hold", () => {
    expect(retirementVerdict({ versions: [3, 2, 1], ...clean })).toEqual({
      blocked: false,
      reasons: [],
      liveVersions: 3,
    });
  });

  test("names every reason at once, in a fixed order", () => {
    expect(
      retirementVerdict({ versions: [3, 2, 1], stale: 4, coverageComplete: false, unrotatable: 1 }).reasons,
    ).toEqual(["unrotatable", "incomplete-coverage", "stale"]);
    expect(retirementVerdict({ versions: [3, 2, 1], ...clean, stale: 1 }).reasons).toEqual(["stale"]);
    expect(retirementVerdict({ versions: [3, 2, 1], ...clean, coverageComplete: false }).reasons).toEqual([
      "incomplete-coverage",
    ]);
    expect(retirementVerdict({ versions: [3, 2, 1], ...clean, unrotatable: 2 }).reasons).toEqual(["unrotatable"]);
  });

  test("is blocked only when a version is due and a reason holds it", () => {
    expect(retirementVerdict({ versions: [3, 2, 1], ...clean, stale: 1 }).blocked).toBe(true);
    // Nothing is due at current and previous, so a reason blocks nothing: the reason is still reported.
    const normal = retirementVerdict({ versions: [2, 1], ...clean, stale: 1 });
    expect(normal).toEqual({ blocked: false, reasons: ["stale"], liveVersions: 2 });
  });

  test("parses as the posture block's verdict", () => {
    expect(RetirementVerdict.parse(retirementVerdict({ versions: [4, 3, 2, 1], ...clean }))).toEqual({
      blocked: false,
      reasons: [],
      liveVersions: 4,
    });
  });
});

describe("guardIsClean", () => {
  test("is whether nothing at all holds a version, blocked or not", () => {
    expect(guardIsClean(retirementVerdict({ versions: [3, 2, 1], ...clean }))).toBe(true);
    expect(guardIsClean(retirementVerdict({ versions: [2, 1], ...clean, unrotatable: 1 }))).toBe(false);
  });
});
