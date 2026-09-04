// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { splitVersion } from "./version";

describe("splitVersion", () => {
  it("splits a release version into its components", () => {
    expect(splitVersion("1.4.2")).toEqual({ version: "1.4.2", major: 1, minor: 4, patch: 2, prerelease: null });
  });

  it("keeps a prerelease tag whole", () => {
    expect(splitVersion("2.0.0-beta.3")).toEqual({
      version: "2.0.0-beta.3",
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: "beta.3",
    });
  });

  it("carries build metadata in neither the components nor the prerelease", () => {
    expect(splitVersion("1.0.0+20260901")).toEqual({
      version: "1.0.0+20260901",
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: null,
    });
    expect(splitVersion("1.0.0-rc.1+20260901").prerelease).toBe("rc.1");
  });

  it("splits the first release", () => {
    expect(splitVersion("0.1.0")).toEqual({ version: "0.1.0", major: 0, minor: 1, patch: 0, prerelease: null });
  });

  it("handles components past a single digit", () => {
    expect(splitVersion("10.20.30")).toEqual({
      version: "10.20.30",
      major: 10,
      minor: 20,
      patch: 30,
      prerelease: null,
    });
  });

  // The whole point of writing the split beside the string is that a client compares columns rather
  // than parsing semver in SQL. A split that disagrees with the string it came from is worse than
  // no split at all, so nothing that is not a version gets one.
  it("refuses anything that is not a semver version", () => {
    for (const bad of ["", "1", "1.2", "v1.2.3", "1.2.3.4", "1.2.x", "latest", "01.2.3"]) {
      expect(() => splitVersion(bad), bad).toThrow(/version/i);
    }
  });

  it("names the version it could not read", () => {
    expect(() => splitVersion("not-a-version")).toThrow(/not-a-version/);
  });
});
