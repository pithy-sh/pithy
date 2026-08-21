// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * What keeps `peerRange.ts` from being a gate that cannot fail.
 *
 * That file compiles `pithy()`'s return against three copies of Vite, and it is worth exactly as much
 * as the claim that they are three *other* copies than the kit's. Two ways it could quietly stop being
 * one: the pins could resolve to the same version `@pithy-sh/vite` resolves, and then TypeScript would
 * be comparing a type to itself and passing on nothing; or the peer range could widen to a major
 * nothing here pins, and the new major would ship unproven while the gate stayed green.
 *
 * Both are asserted below, and neither is derived from what it checks: the expected majors are read off
 * `packages/vite/package.json`, the pins are read off this package's own manifest, and the copies are
 * resolved from disk.
 *
 * A third thing this catches for free is the install layout changing under us. bun nests a package's
 * `node_modules/vite` only when its version differs from the hoisted one; the day it decides otherwise,
 * the realpaths collapse and this fails rather than the compile silently weakening.
 */

/**
 * The kit package whose peer range this fixture exists to prove, as one expression from
 * `import.meta.url`.
 *
 * **The single expression is load-bearing rather than a style.**
 * `.github/scripts/crossPackageReads.ts` resolves this literal statically to tell CI which suites a diff
 * must re-run, and to record in `packages/cli/src/ci/crossPackageReads.test.ts` that the read exists at
 * all. Built as `join(REPO_ROOT, "packages", "vite")` the script cannot follow the variable, and the
 * read disappears from the record — which is the register, not the planner: this package declares
 * `@pithy-sh/vite` as a dependency, so `--affected` reaches it either way today. What the entry buys is
 * that moving the peer range somewhere the dependency edge does not carry is a visible change rather
 * than a silent one.
 */
const KIT_MANIFEST = fileURLToPath(new URL("../../../packages/vite/package.json", import.meta.url));

/** This package's own manifest — the pins. Inside the package, so not a cross-package read. */
const OWN_MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));

type Manifest = { devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The majors a `^6.1.0 || ^7.0.0 || ^8.0.0` style range admits, sorted. */
function majors(range: string): number[] {
  return [...new Set([...range.matchAll(/(\d+)\.\d+\.\d+/g)].map(([, major]) => Number(major)))].sort((a, b) => a - b);
}

/** The pinned version behind a plain dependency or an `npm:vite@x.y.z` alias. */
function pinned(spec: string): string {
  return spec.startsWith("npm:") ? (spec.split("@").pop() as string) : spec;
}

/**
 * The copy of `name` that a file in `from` resolves, as a realpath.
 *
 * Walked rather than `require.resolve`d: the question is which directory on disk a compiler following
 * node resolution lands in, and that is what TypeScript answers too. `realpathSync` because bun links
 * every install into one content-addressed store — two packages that resolve the same version resolve
 * the same directory, and that identity is the whole subject here.
 */
function resolveCopy(from: string, name: string): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no ${name} resolvable from ${from}`);
    dir = parent;
  }
}

/** The `version` a resolved copy reports. */
function versionOf(copy: string): string {
  return (JSON.parse(readFileSync(join(copy, "package.json"), "utf8")) as { version: string }).version;
}

/** The alias each major is pinned under here. `vite` is bare so `peerRange.ts` can be read as an adopter's file. */
const ALIASES: Record<number, string> = { 6: "vite", 7: "vite7", 8: "vite8" };

describe("the fixture really resolves a different Vite than the kit does", () => {
  const kit = manifest(KIT_MANIFEST);
  const own = manifest(OWN_MANIFEST);
  const peerMajors = majors(kit.peerDependencies?.vite ?? "");

  test("every major the peer range admits is pinned here", () => {
    // The vacuity floor. A range that stopped parsing — a rename, a reformat, a spelling this regex
    // does not know — would otherwise make both sides of the comparison empty, which passes.
    expect(peerMajors.length).toBeGreaterThanOrEqual(3);
    expect(peerMajors).toEqual(
      Object.keys(ALIASES)
        .map(Number)
        .sort((a, b) => a - b),
    );

    for (const major of peerMajors) {
      const spec = own.devDependencies?.[ALIASES[major] as string];
      expect(spec, `no copy of vite ${major} pinned as ${ALIASES[major]}`).toBeTypeOf("string");
      // Exact, never a range: a range is what lets a pin drift onto the kit's own copy.
      expect(pinned(spec as string)).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Number(pinned(spec as string).split(".")[0])).toBe(major);
    }
  });

  test("the kit's copy is a fourth copy, distinct from all three", () => {
    const kitCopy = resolveCopy(dirname(KIT_MANIFEST), "vite");
    const copies = peerMajors.map((major) => resolveCopy(dirname(OWN_MANIFEST), ALIASES[major] as string));

    // Four directories, not three or fewer.
    expect(new Set([kitCopy, ...copies]).size).toBe(copies.length + 1);

    // And one of the four shares the kit's own major while being a different copy of it. That is the
    // case the dashboard actually hit — a patch apart is enough to make two `Plugin` types two types —
    // and it is the one a careless bump erases, by pinning this fixture at whatever the kit resolves.
    // Derived from what the kit resolves rather than written as `8`, so it survives the kit moving on.
    const kitMajor = Number(versionOf(kitCopy).split(".")[0]);
    const twin = copies[peerMajors.indexOf(kitMajor)];
    expect(twin, `no copy of vite ${kitMajor} pinned beside the kit's own`).toBeTypeOf("string");
    expect(versionOf(twin as string)).not.toBe(versionOf(kitCopy));

    // Each copy is the version its pin names, so a stale `node_modules` reads as a failure here rather
    // than as a compile against something nobody chose.
    for (const [index, major] of peerMajors.entries()) {
      const spec = own.devDependencies?.[ALIASES[major] as string] as string;
      expect(versionOf(copies[index] as string)).toBe(pinned(spec));
    }
  });

  test("the kit still develops against a copy inside its own peer range", () => {
    // Not a restatement of the compile: this is the premise the compile rests on. If the kit ever
    // resolved a Vite outside the range it publishes, `peerRange.ts` would be proving compatibility
    // between two things an adopter can never have at once.
    expect(peerMajors).toContain(Number(versionOf(resolveCopy(dirname(KIT_MANIFEST), "vite")).split(".")[0]));
  });
});
