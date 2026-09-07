// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MINIMUM_NODE, olderThan, unsupportedNodeMessage } from "./nodeFloor";

describe("olderThan", () => {
  // The bug this function was written wrong as, first time. Compared component-wise and independently,
  // 24.13.0 reads as older than 22.18.0 because 13 < 18 — and the CLI refused the newest Node there is.
  test("decides at the first component that differs, not at every one", () => {
    expect(olderThan([24, 13, 0], [22, 18, 0])).toBe(false);
    expect(olderThan([23, 5, 0], [22, 18, 0])).toBe(false);
  });

  test("the boundary itself is supported", () => {
    expect(olderThan([22, 18, 0], [22, 18, 0])).toBe(false);
    expect(olderThan([22, 17, 9], [22, 18, 0])).toBe(true);
  });

  test("a shorter version is padded rather than refused", () => {
    expect(olderThan([22, 18], [22, 18, 0])).toBe(false);
    expect(olderThan([23], [22, 18, 0])).toBe(false);
    expect(olderThan([22], [22, 18, 0])).toBe(true);
  });
});

describe("unsupportedNodeMessage", () => {
  test("refuses below the floor, naming both versions and the reason", () => {
    const message = unsupportedNodeMessage("22.10.0") ?? "";
    expect(message).toContain("22.18.0");
    expect(message).toContain("22.10.0");
    // The reason matters as much as the number: an adopter needs to know it is about their config.
    expect(message).toContain("pithy.config.ts");
  });

  test("says nothing at or above the floor", () => {
    for (const version of ["22.18.0", "22.20.1", "24.13.0"]) {
      expect(unsupportedNodeMessage(version)).toBeNull();
    }
  });

  // Refusing to start over a version string we could not read is worse than trying: a runtime reporting
  // something unexpected is not evidence that it is old.
  test("says nothing about a version it cannot read", () => {
    for (const version of ["", "not-a-version", "22.x.0"]) {
      expect(unsupportedNodeMessage(version)).toBeNull();
    }
  });
});

/**
 * The declared floor and the enforced one are the same number.
 *
 * `engines` is what an installer reads and `MINIMUM_NODE` is what actually refuses, so the two
 * disagreeing means either a version installs and cannot run, or one is turned away that would have
 * worked. Read from the manifest rather than restated, because a literal here is the second copy.
 */
test("engines.node states the floor this file enforces", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
  };
  expect(manifest.engines?.node).toBe(`>=${MINIMUM_NODE.join(".")}`);
});
