// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  admits,
  candidateVersions,
  crossesBreakingBoundary,
  type DeclaredSpec,
  declaredSpecs,
  newestAdmitted,
  packageCommand,
  parseRange,
  rewriteRange,
  unmanagedReason,
} from "./ranges";

/** Parse a spec the test knows to be managed, failing loudly if it is not. */
function range(spec: string) {
  const parsed = parseRange(spec);
  if (!parsed) throw new Error(`${spec} should be a managed range`);
  return parsed;
}

describe("parseRange", () => {
  test("caret, tilde and an exact pin are managed", () => {
    expect(range("^0.2.0")).toMatchObject({ operator: "^", floor: "0.2.0" });
    expect(range("~1.2.0")).toMatchObject({ operator: "~", floor: "1.2.0" });
    expect(range("0.2.0")).toMatchObject({ operator: "", floor: "0.2.0" });
  });

  test.each([
    "workspace:*",
    "workspace:^0.2.0",
    "link:../pithy/packages/auth",
    "file:../auth",
    "portal:../auth",
    "npm:@pithy-sh/auth@^0.2.0",
    "github:pithy-sh/pithy",
    "git+https://github.com/pithy-sh/pithy.git",
    "https://example.com/auth.tgz",
    "latest",
    "next",
    "*",
    "",
    ">=0.2.0",
    "^0.2.0 || ^0.3.0",
    "0.2.x",
    "0.x",
    "^0.2",
    "^0.3.0-rc.1",
    "0.3.0-beta.2",
    ">0.2.0 <0.3.0",
  ])("%j is left alone as not a registry range", (spec) => {
    expect(parseRange(spec)).toBeNull();
    expect(unmanagedReason(spec)).toBe("not-a-registry-range");
  });
});

describe("admits", () => {
  test("^0.2.0 admits 0.2.9 and not 0.3.0 — a 0.x minor is breaking", () => {
    expect(admits(range("^0.2.0"), "0.2.9")).toBe(true);
    expect(admits(range("^0.2.0"), "0.3.0")).toBe(false);
  });

  test("^1.2.0 admits 1.9.0 and not 2.0.0", () => {
    expect(admits(range("^1.2.0"), "1.9.0")).toBe(true);
    expect(admits(range("^1.2.0"), "2.0.0")).toBe(false);
  });

  test("~1.2.0 admits 1.2.5 and rejects 1.3.0", () => {
    expect(admits(range("~1.2.0"), "1.2.5")).toBe(true);
    expect(admits(range("~1.2.0"), "1.3.0")).toBe(false);
  });

  test("^0.0.3 admits 0.0.3 alone", () => {
    expect(admits(range("^0.0.3"), "0.0.3")).toBe(true);
    expect(admits(range("^0.0.3"), "0.0.4")).toBe(false);
  });

  test("nothing below the floor, and an exact pin admits itself alone", () => {
    expect(admits(range("^0.2.3"), "0.2.2")).toBe(false);
    expect(admits(range("0.2.0"), "0.2.0")).toBe(true);
    expect(admits(range("0.2.0"), "0.2.1")).toBe(false);
  });

  test("a prerelease is never admitted", () => {
    expect(admits(range("^0.2.0"), "0.2.5-rc.1")).toBe(false);
  });
});

describe("candidateVersions", () => {
  test("drops prereleases, deprecated versions, and anything newer than the latest tag", () => {
    const candidates = candidateVersions({
      latest: "0.3.1",
      versions: {
        "0.2.0": {},
        "0.2.1": { deprecated: "Broken build." },
        "0.2.3": {},
        "0.3.0-rc.1": {},
        "0.3.1": {},
        "0.4.0": {},
      },
    });
    expect(candidates).toEqual(["0.2.0", "0.2.3", "0.3.1"]);
  });

  test("sorted by version, not by text", () => {
    const candidates = candidateVersions({ latest: "0.10.0", versions: { "0.10.0": {}, "0.9.0": {}, "0.2.0": {} } });
    expect(candidates).toEqual(["0.2.0", "0.9.0", "0.10.0"]);
  });
});

describe("newestAdmitted", () => {
  test("the newest candidate the range admits, or null", () => {
    expect(newestAdmitted(range("^0.2.0"), ["0.2.0", "0.2.3", "0.3.1"])).toBe("0.2.3");
    expect(newestAdmitted(range("^0.4.0"), ["0.2.0", "0.3.1"])).toBeNull();
  });
});

describe("crossesBreakingBoundary", () => {
  test("a new major, and a new minor under 0.x, cross it", () => {
    expect(crossesBreakingBoundary("1.9.0", "2.0.0")).toBe(true);
    expect(crossesBreakingBoundary("0.2.0", "0.3.0")).toBe(true);
    expect(crossesBreakingBoundary("0.2.0", "0.3.1")).toBe(true);
  });

  test("a patch, and a minor past 1.0, do not", () => {
    expect(crossesBreakingBoundary("0.2.0", "0.2.3")).toBe(false);
    expect(crossesBreakingBoundary("1.2.0", "1.3.0")).toBe(false);
  });

  test("an unparseable pair crosses nothing", () => {
    expect(crossesBreakingBoundary("workspace:*", "2.0.0")).toBe(false);
  });
});

describe("rewriteRange", () => {
  test("keeps the operator, and an exact pin stays exact", () => {
    expect(rewriteRange(range("^0.2.0"), "0.2.3")).toBe("^0.2.3");
    expect(rewriteRange(range("~1.2.0"), "1.2.5")).toBe("~1.2.5");
    expect(rewriteRange(range("0.2.0"), "0.3.1")).toBe("0.3.1");
  });
});

describe("packageCommand", () => {
  const spec = (value: string, manifest = "package.json"): DeclaredSpec => ({
    name: "@pithy-sh/auth",
    manifest,
    field: "dependencies",
    spec: value,
  });

  test("declared nowhere: no command, and no spec to blame", () => {
    expect(packageCommand([], "0.2.3")).toEqual({ command: null, declaredAs: null });
  });

  test("an unmanaged spec anywhere: no command, and it names the spec", () => {
    expect(packageCommand([spec("^0.2.0"), spec("workspace:*", "apps/board/package.json")], "0.2.3")).toEqual({
      command: null,
      declaredAs: "workspace:*",
    });
  });

  test("every range admits latest: the in-range move reaches it", () => {
    expect(packageCommand([spec("^0.2.0"), spec("~0.2.1", "apps/board/package.json")], "0.2.3")).toEqual({
      command: "pithy upgrade --packages",
      declaredAs: null,
    });
  });

  test("one range short of latest: only --latest reaches it", () => {
    expect(packageCommand([spec("^0.2.0"), spec("^0.3.0", "apps/board/package.json")], "0.3.1").command).toBe(
      "pithy upgrade --packages --latest",
    );
    expect(packageCommand([spec("1.1.8")], "1.2.0").command).toBe("pithy upgrade --packages --latest");
  });
});

describe("declaredSpecs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ranges-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("every @pithy-sh/* key in both fields of the root and each apps/* manifest, cli included", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { "@pithy-sh/auth": "^0.2.0", react: "^19.0.0" },
        devDependencies: { "@pithy-sh/cli": "^0.9.5" },
      }),
    );
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(
      join(dir, "apps", "board", "package.json"),
      JSON.stringify({ dependencies: { "@pithy-sh/auth": "^0.2.0" } }),
    );
    // A directory with no manifest, and a manifest that will not parse, cost nothing but themselves.
    await mkdir(join(dir, "apps", "empty"), { recursive: true });
    await mkdir(join(dir, "apps", "broken"), { recursive: true });
    await writeFile(join(dir, "apps", "broken", "package.json"), "{ nope");

    expect(await declaredSpecs(dir)).toEqual([
      { name: "@pithy-sh/auth", manifest: "package.json", field: "dependencies", spec: "^0.2.0" },
      { name: "@pithy-sh/cli", manifest: "package.json", field: "devDependencies", spec: "^0.9.5" },
      { name: "@pithy-sh/auth", manifest: "apps/board/package.json", field: "dependencies", spec: "^0.2.0" },
    ]);
  });

  test("no manifest at all declares nothing", async () => {
    expect(await declaredSpecs(dir)).toEqual([]);
  });
});
