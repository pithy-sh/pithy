// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every publishable package's version, read straight off the manifests.
 *
 * The release job reads this twice — once before `changeset version` and once after — and the pair is
 * what {@link ./records.joinRecords} joins the changeset snapshot to. Reading the manifests rather than
 * parsing `changeset version`'s output is deliberate: the manifest is what `npm publish` will read, so
 * it is the only source that cannot disagree with what actually ships.
 *
 * **Private packages are excluded**, because `changeset publish` will not publish them and a record for
 * one would tell an adopter about a package they cannot install. That is `tooling/*` — repo machinery,
 * pinned at `0.0.0` forever.
 *
 * The workspace areas are hard-coded rather than read from the root manifest's `workspaces` globs.
 * Those are two-segment globs with no exclusions today, and a glob engine here would be more code than
 * the thing it generalizes; `workspace.test.ts` holds the list against the root manifest so the two cannot
 * drift apart.
 */

/** The workspace areas this repo publishes from — every `<area>/<dir>/package.json`. */
export const WORKSPACE_AREAS = ["packages", "tooling", "apps"] as const;

/** One publishable package, as it sits in the workspace. */
export interface PublishedPackage {
  /** The npm package name, e.g. `@pithy-sh/auth`. */
  name: string;
  /** Its version, as the manifest reads right now. */
  version: string;
  /** Its directory relative to the repo root, e.g. `packages/auth`. */
  dir: string;
}

/** One manifest, in the two fields a release cares about. */
interface Manifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
}

/**
 * Every publishable package under the repo root, ordered by name so two reads of one tree compare equal.
 *
 * **The directory is read, never derived from the name.** `@pithy-sh/auth` lives in `packages/auth` in
 * every case this repo has today, and deriving it would work until it did not — at which point `replay`
 * would skip that package's changelog in silence, which is the under-reporting this whole mechanism
 * exists to prevent.
 */
export function publishedPackages(root: string): PublishedPackage[] {
  const found: PublishedPackage[] = [];

  for (const area of WORKSPACE_AREAS) {
    const areaDir = join(root, area);
    if (!existsSync(areaDir)) continue;

    for (const dir of readdirSync(areaDir).sort()) {
      const manifestPath = join(areaDir, dir, "package.json");
      // A directory in a workspace area that holds no manifest is not a package. `apps/` in a fresh
      // checkout is exactly this, and so is any stray build output.
      if (!existsSync(manifestPath)) continue;

      let manifest: Manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      } catch (error) {
        throw new Error(`${area}/${dir}/package.json: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || manifest.name === "") {
        throw new Error(`${area}/${dir}/package.json: no name`);
      }
      if (typeof manifest.version !== "string" || manifest.version === "") {
        throw new Error(`${area}/${dir}/package.json: no version`);
      }
      found.push({ name: manifest.name, version: manifest.version, dir: `${area}/${dir}` });
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Package name → version, for every publishable package. The shape the record join wants. */
export function publishedVersions(root: string): Map<string, string> {
  return new Map(publishedPackages(root).map((pkg) => [pkg.name, pkg.version]));
}
