// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { bunFloorRefusal } from "./bunFloor";

describe("bunFloorRefusal", () => {
  test("says nothing for the floor itself", () => {
    expect(bunFloorRefusal("1.4.3", ">=1.4.3")).toBeNull();
  });

  test("says nothing for a newer Bun", () => {
    expect(bunFloorRefusal("1.4.10", ">=1.4.3")).toBeNull();
    expect(bunFloorRefusal("1.5.0", ">=1.4.3")).toBeNull();
    expect(bunFloorRefusal("2.0.0", ">=1.4.3")).toBeNull();
  });

  // The case it exists for: Bun 1.4.2 answers `bun check` with `Script not found "check"`, once per
  // workspace, and never names a version.
  test("refuses an older Bun, naming both versions and the remedy", () => {
    expect(bunFloorRefusal("1.4.2", ">=1.4.3")).toBe(
      "Bun 1.4.2 is older than this repository needs (>=1.4.3). Run `bun upgrade`, then this again.",
    );
  });

  // Compared as numbers, never as strings: "1.4.10" sorts before "1.4.3" as text.
  test("compares each segment as a number", () => {
    expect(bunFloorRefusal("1.4.9", ">=1.4.10")).not.toBeNull();
    expect(bunFloorRefusal("1.4.10", ">=1.4.9")).toBeNull();
  });

  // A canary or prerelease build carries a suffix after the patch; the release it is built toward is
  // what counts.
  test("reads a version with a suffix by its release", () => {
    expect(bunFloorRefusal("1.4.3-canary.12+abc", ">=1.4.3")).toBeNull();
    expect(bunFloorRefusal("1.4.2-canary.1", ">=1.4.3")).not.toBeNull();
  });

  // A floor it cannot read would otherwise pass every Bun.
  test("throws on a floor it cannot read", () => {
    expect(() => bunFloorRefusal("1.4.3", "^1.4.3")).toThrow(/engines\.bun/);
    expect(() => bunFloorRefusal("1.4.3", "")).toThrow(/engines\.bun/);
  });

  test("throws on a running version it cannot read", () => {
    expect(() => bunFloorRefusal("unknown", ">=1.4.3")).toThrow(/Bun version/);
  });
});
