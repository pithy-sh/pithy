// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, it } from "vitest";
import { CATALOG, capabilityPackageDir } from "./catalog";

/**
 * **Every package that ships a capability can be added.** The other direction of `catalog.test.ts`.
 *
 * That file proves every *catalog entry* resolves to a package exporting its factory — the direction that
 * starts from the catalog and looks outward. Nothing proved the direction that starts from the packages:
 * that a package contributing a `Capability` is one an adopter can reach at all. So
 * `@pithy-sh/matchmaking` and `@pithy-sh/rating` shipped complete — routes, migrations, seeds, workers
 * tests, stamped versions, every repo-wide gate green — and `pithy add matchmaking` answered *no
 * capability named "matchmaking" is installed*, having just installed it (#415).
 *
 * Two things make a capability addable, and neither is code:
 *
 * - **the manifest.** `runAdd` installs the package and then reads `pithy.manifest.json` for the
 *   bindings to write into `wrangler.jsonc` and the config to scaffold. No manifest, no wiring — and for
 *   a capability whose bindings include a Durable Object, no supported path to a `wrangler.jsonc` that
 *   works at all, because the class migration tag is written from that file and nowhere else.
 * - **the catalog entry.** `pithy add --list` is built from `CATALOG`, and a package with no entry is
 *   invisible before the failure the missing manifest produces after it.
 *
 * **Keyed on `src/capability.ts`, never on the manifest** — the same rule `scripts/stampVersions.ts`
 * learned the hard way. The manifest looks like the obvious signal for "is this a capability" and is the
 * wrong one: it is the artifact that goes missing, so a manifest-keyed sweep skips exactly the packages
 * it exists to catch, in silence. Repo-wide and unconditional, like `project/capabilityVersions.test.ts`
 * and `migrations/orders.test.ts`: the property is only true as a set.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../../../packages");

/** Whether a path exists — `statSync` throwing is the only way to ask without a race. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One package that contributes a `Capability`: its directory, and the file that declares it. */
interface CapabilityPackage {
  /** The directory under `packages/` — which is also the `node_modules/@pithy-sh/<dir>` a manifest is read from. */
  dir: string;
  /** The `src/capability.ts` that declares it. */
  file: string;
}

/**
 * Every package that contributes a `Capability`, and the file that declares it.
 *
 * Mirrors `capabilityPackages()` in `project/capabilityVersions.test.ts` and `definesCapability` in
 * `scripts/stampVersions.ts` deliberately: three readers of one fact, and a package the three disagree
 * about is a package one of them is quietly skipping.
 */
function capabilityPackages(): CapabilityPackage[] {
  const found: CapabilityPackage[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const packageDir = join(PACKAGES, dir);
    if (!exists(join(packageDir, "package.json"))) continue;

    // `core`'s capability is at `src/controlPlane/capability.ts`; every other is at `src/capability.ts`.
    const file =
      dir === "core" ? join(packageDir, "src/controlPlane/capability.ts") : join(packageDir, "src/capability.ts");
    if (exists(file)) found.push({ dir, file });
  }
  return found;
}

/** The manifest a package ships, or `undefined` where it ships none — which is the defect this file is about. */
function manifestOf(dir: string): CapabilityManifest | undefined {
  const path = join(PACKAGES, dir, "pithy.manifest.json");
  if (!exists(path)) return undefined;
  return CapabilityManifest.parse(JSON.parse(readFileSync(path, "utf8")));
}

describe("every capability package is addable", () => {
  const packages = capabilityPackages();

  it("finds the capability packages at all, so this cannot pass vacuously", () => {
    // Every assertion below is a `filter(...)` over this list and is green over an empty one — a
    // `PACKAGES` path that moved would leave the whole file passing while checking no capability.
    expect(packages.length).toBeGreaterThan(15);
  });

  it("ships a pithy.manifest.json for each, so pithy add has bindings and config to write", () => {
    const missing = packages.filter((pkg) => manifestOf(pkg.dir) === undefined).map((pkg) => pkg.dir);
    expect(
      missing,
      "write packages/<name>/pithy.manifest.json — without it `pithy add <name>` refuses a package it has just installed",
    ).toEqual([]);
  });

  it("lists each in the catalog, so pithy add --list can offer it", () => {
    const uncatalogued = packages
      .filter((pkg) => {
        const manifest = manifestOf(pkg.dir);
        return manifest !== undefined && !CATALOG.some((entry) => entry.name === manifest.name);
      })
      .map((pkg) => pkg.dir);
    expect(uncatalogued, "add a CATALOG entry in capabilities/catalog.ts").toEqual([]);
  });

  it("agrees with the catalog about which package a capability lives in", () => {
    // `capabilityPackageDir` is what `pithy add` resolves the manifest path from, so a catalog entry
    // naming a different package than the manifest is a lookup into a directory that is not there.
    const disagreeing: string[] = [];
    for (const pkg of packages) {
      const manifest = manifestOf(pkg.dir);
      if (manifest === undefined) continue;
      const entry = CATALOG.find((candidate) => candidate.name === manifest.name);
      if (entry === undefined) continue;
      if (entry.package !== manifest.package) disagreeing.push(`${pkg.dir}: ${entry.package} ≠ ${manifest.package}`);
      if (capabilityPackageDir(manifest.name) !== pkg.dir) {
        disagreeing.push(`${pkg.dir}: resolves to ${capabilityPackageDir(manifest.name)}`);
      }
    }
    expect(disagreeing).toEqual([]);
  });

  it("says what each is for, in the one sentence the CLI has to explain it with", () => {
    // `whenToEnable` is what `pithy add --list` prints and what `pithy init` shows when it offers a
    // profile. A capability with none has no surface anywhere that can say what it does.
    const unexplained = packages
      .filter((pkg) => {
        const manifest = manifestOf(pkg.dir);
        return manifest !== undefined && (manifest.whenToEnable ?? "").trim() === "";
      })
      .map((pkg) => pkg.dir);
    expect(unexplained, "add a whenToEnable to that manifest").toEqual([]);
  });
});
