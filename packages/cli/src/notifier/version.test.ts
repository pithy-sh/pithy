// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { classifyBump, compareVersions, parseVersion } from "./version";

describe("parseVersion", () => {
  test("parses a plain triple", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("ignores a leading v and a prerelease/build suffix", () => {
    expect(parseVersion("v2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseVersion("1.4.0-rc.1")).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseVersion("1.4.0+build.7")).toEqual({ major: 1, minor: 4, patch: 0 });
  });

  test("rejects a non-triple", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("1.x.0")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });

  test("treats an unparseable version as equal", () => {
    expect(compareVersions("nope", "1.2.3")).toBe(0);
  });
});

describe("classifyBump", () => {
  test("none when installed is at or ahead of latest", () => {
    expect(classifyBump("1.3.0", "1.3.0")).toBe("none");
    expect(classifyBump("1.4.0", "1.3.0")).toBe("none");
  });

  test("patch, minor, major", () => {
    expect(classifyBump("1.2.0", "1.2.1")).toBe("patch");
    expect(classifyBump("1.2.0", "1.3.0")).toBe("minor");
    expect(classifyBump("1.4.0", "2.0.0")).toBe("major");
  });

  test("a change in a higher-order component dominates", () => {
    // patch also moved, but the new minor is what matters.
    expect(classifyBump("1.2.5", "1.3.1")).toBe("minor");
  });

  test("none for an unparseable pair", () => {
    expect(classifyBump("1.2.0", "garbage")).toBe("none");
  });

  test("a prerelease of the same core is not a bump, in either direction", () => {
    // The narrowness this module exists for, pinned now that the ordering comes from a primitive that
    // *can* rank prereleases. A user on the stable channel must not be nagged about an `rc.1`.
    expect(classifyBump("1.3.0", "1.3.0-rc.1")).toBe("none");
    expect(classifyBump("1.3.0-rc.1", "1.3.0")).toBe("none");
  });
});
