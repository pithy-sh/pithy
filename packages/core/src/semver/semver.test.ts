// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { compareSemver, formatSemver, parseSemver, type Semver, semverGap } from "./semver";

describe("parseSemver", () => {
  test("splits a stable version into its parts with a null prerelease", () => {
    expect(parseSemver("1.4.2")).toEqual({ major: 1, minor: 4, patch: 2, prerelease: null });
  });

  test("keeps the prerelease tag without its leading hyphen", () => {
    expect(parseSemver("2.0.0-rc.1")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: "rc.1" });
  });

  test("drops build metadata, which semver excludes from precedence", () => {
    expect(parseSemver("1.0.0+20260805")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: null });
    expect(parseSemver("1.0.0-beta+exp.sha.5114f85")?.prerelease).toBe("beta");
  });

  test("accepts a leading v, which tags and changelogs carry", () => {
    expect(parseSemver("v1.4.2")).toEqual({ major: 1, minor: 4, patch: 2, prerelease: null });
  });

  test("returns null for anything that is not a version", () => {
    for (const bad of ["", "1", "1.2", "1.2.x", "latest", "1.2.3.4", "-1.0.0", "01.2.3", "1.2.3-"]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });

  test("rejects a version whose parts exceed what a number holds exactly", () => {
    expect(parseSemver("99999999999999999999.0.0")).toBeNull();
  });
});

describe("formatSemver", () => {
  test("round-trips every shape a parse produces", () => {
    for (const version of ["1.4.2", "2.0.0-rc.1", "1.0.0-alpha.beta"]) {
      expect(formatSemver(parseSemver(version) as Semver), version).toBe(version);
    }
  });

  test("drops what the parse dropped, so the canonical form carries no build metadata", () => {
    expect(formatSemver(parseSemver("1.0.0-beta+exp.sha.5114f85") as Semver)).toBe("1.0.0-beta");
  });
});

describe("compareSemver", () => {
  test("orders by major, then minor, then patch — not as a string", () => {
    // The whole reason the parse splits. As text, "1.10.0" sorts below "1.9.0".
    expect(compareSemver(parseSemver("1.10.0"), parseSemver("1.9.0"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("1.9.0"), parseSemver("1.10.0"))).toBeLessThan(0);
  });

  test("ranks a stable release above a prerelease of the same core", () => {
    expect(compareSemver(parseSemver("2.0.0"), parseSemver("2.0.0-rc.1"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("2.0.0-rc.1"), parseSemver("2.0.0"))).toBeLessThan(0);
  });

  test("orders prereleases of one version against each other", () => {
    expect(compareSemver(parseSemver("2.0.0-rc.2"), parseSemver("2.0.0-rc.1"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("2.0.0-beta"), parseSemver("2.0.0-alpha"))).toBeGreaterThan(0);
  });

  test("walks the spec's own prerelease precedence chain, step by step", () => {
    // Semver §11.4's worked example, every adjacent pair, both ways round. Two of the rules are
    // reachable from nowhere else in this suite, and inverting either would otherwise leave it green:
    // `alpha.1 < alpha.beta` is "a numeric identifier ranks below an alphanumeric one", and
    // `alpha < alpha.1` is "the larger set of identifiers wins when every shared one is equal". Both
    // decide which release a caller calls `latest`, so a regression there mislabels the newest version
    // rather than failing loudly.
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (const [index, lower] of ascending.slice(0, -1).entries()) {
      const higher = ascending[index + 1] as string;
      expect(compareSemver(parseSemver(lower), parseSemver(higher)), `${lower} < ${higher}`).toBeLessThan(0);
      expect(compareSemver(parseSemver(higher), parseSemver(lower)), `${higher} > ${lower}`).toBeGreaterThan(0);
    }
  });

  test("ranks a numeric prerelease identifier below an alphanumeric one", () => {
    // §11.4.3, stated on its own rather than only as a link in the chain above. `1` is not "less than
    // `beta` because 1 sorts before b" — a numeric identifier ranks below an alphanumeric one whatever
    // the characters are, which is why `alpha.9` still precedes `alpha.a`.
    expect(compareSemver(parseSemver("1.0.0-alpha.1"), parseSemver("1.0.0-alpha.beta"))).toBeLessThan(0);
    expect(compareSemver(parseSemver("1.0.0-alpha.9"), parseSemver("1.0.0-alpha.a"))).toBeLessThan(0);
  });

  test("orders numeric prerelease identifiers no float could tell apart", () => {
    // `Number(a) - Number(b)` calls these equal: both round to 10000000000000000 as a double, and two
    // distinct versions comparing equal leaves `latest` decided by whatever order the rows arrived in.
    // Compared as digit strings there is no rounding to lose — the grammar forbids leading zeros, so
    // more digits is a larger number.
    expect(
      compareSemver(parseSemver("1.0.0-10000000000000001"), parseSemver("1.0.0-10000000000000000")),
    ).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("1.0.0-9"), parseSemver("1.0.0-10"))).toBeLessThan(0);
  });

  test("compares equal versions as equal", () => {
    expect(compareSemver(parseSemver("1.2.3"), parseSemver("1.2.3"))).toBe(0);
    expect(compareSemver(parseSemver("1.2.3-rc.1"), parseSemver("1.2.3-rc.1"))).toBe(0);
  });

  test("sorts an unparseable version below every real one instead of throwing", () => {
    // The comparator takes what the parser returns, so a feed with one bad entry still sorts.
    expect(compareSemver(null, parseSemver("0.0.0"))).toBeLessThan(0);
    expect(compareSemver(parseSemver("0.0.0"), null)).toBeGreaterThan(0);
    expect(compareSemver(null, null)).toBe(0);
  });

  test("sorts a realistic release list into ascending precedence", () => {
    const sorted = ["1.10.0", "1.9.0", "2.0.0", "2.0.0-rc.1", "1.9.1"]
      .map(parseSemver)
      .sort(compareSemver)
      .map((v) => formatSemver(v as Semver));
    expect(sorted).toEqual(["1.9.0", "1.9.1", "1.10.0", "2.0.0-rc.1", "2.0.0"]);
  });
});

describe("semverGap", () => {
  test("counts how far behind a version is, as majors, minors and patches", () => {
    expect(semverGap(parseSemver("1.2.3") as Semver, parseSemver("3.5.9") as Semver)).toEqual({
      major: 2,
      minor: 5,
      patch: 9,
    });
  });

  test("counts only the minors and patches that accrued within the current major", () => {
    expect(semverGap(parseSemver("1.2.3") as Semver, parseSemver("1.6.1") as Semver)).toEqual({
      major: 0,
      minor: 4,
      patch: 1,
    });
    expect(semverGap(parseSemver("1.2.3") as Semver, parseSemver("1.2.9") as Semver)).toEqual({
      major: 0,
      minor: 0,
      patch: 6,
    });
  });

  test("an equal core is no distance in any place, even when it is behind by precedence", () => {
    // `1.2.3-rc.1` precedes `1.2.3`, and the gap is still zero — because the gap counts *places*, and
    // no place moved. The difference between them is precedence, which `compareSemver` owns and this
    // shape cannot express. Pinned so nobody reads a zero gap as proof of being current.
    expect(compareSemver(parseSemver("1.2.3-rc.1"), parseSemver("1.2.3"))).toBeLessThan(0);
    expect(semverGap(parseSemver("1.2.3-rc.1") as Semver, parseSemver("1.2.3") as Semver)).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
    });
  });

  test("reports no gap when the installed version is current or ahead", () => {
    const zero = { major: 0, minor: 0, patch: 0 };
    expect(semverGap(parseSemver("2.0.0") as Semver, parseSemver("2.0.0") as Semver)).toEqual(zero);
    // Somebody running something newer than we know about is ahead, not behind. Never a negative gap.
    expect(semverGap(parseSemver("3.0.0") as Semver, parseSemver("2.9.9") as Semver)).toEqual(zero);
  });
});
