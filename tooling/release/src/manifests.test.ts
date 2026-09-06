// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishedPackages } from "./workspace";

/**
 * What every published manifest must say before `changeset publish` reads it.
 *
 * Whole-repo, and for the reason the other whole-repo gates give: these properties are only true as a
 * set. A package that lands without them does not fail its own tests — it fails the release, on the day
 * of the release, which is the worst moment to find out.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const REPOSITORY_URL = "git+https://github.com/pithy-sh/pithy.git";

interface Manifest {
  name: string;
  license?: string;
  private?: boolean;
  packageManager?: string;
  engines?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Every published package, with the directory it lives in. */
function publishedManifests(): Array<{ dir: string; manifest: Manifest }> {
  return publishedPackages(ROOT).map((pkg) => ({
    dir: pkg.dir,
    manifest: JSON.parse(readFileSync(join(ROOT, pkg.dir, "package.json"), "utf8")) as Manifest,
  }));
}

describe("published manifests", () => {
  const manifests = publishedManifests();

  it("finds every published package", () => {
    expect(manifests.length).toBe(publishedPackages(ROOT).length);
    expect(manifests.length).toBeGreaterThan(20);
  });

  // npm provenance is generated from the repository the build ran in, and it refuses to attest a
  // package whose manifest does not say which repository that is. Without this the first release
  // publishes with no provenance at all — silently, because nothing else notices.
  it("each declares the repository, so npm can attest provenance", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.repository?.url, `${dir} repository.url`).toBe(REPOSITORY_URL);
      expect(manifest.repository?.type, `${dir} repository.type`).toBe("git");
    }
  });

  // `directory` is what points npm's "Repository" link at the package rather than the monorepo root.
  // A wrong one is worse than none: it links a reader to somebody else's code.
  it("each points at its own directory within the repository", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.repository?.directory, `${dir} repository.directory`).toBe(dir);
    }
  });

  it("each declares the Node floor adopters install against", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.engines?.node, `${dir} engines.node`).toBe(">=22");
    }
  });

  // `packageManager` is a workspace signal for Turbo and Corepack. Published, it tells an adopter's
  // toolchain to install Bun to use a package that runs anywhere — see CLAUDE.md §Toolchain.
  it("none carries packageManager, which belongs to the private root alone", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.packageManager, `${dir} packageManager`).toBeUndefined();
    }
  });

  // #475. `z.record`'s key check enumerated symbol keys below zod 4.4.0, and comment-json hangs a
  // document's comments off exactly those — so `pithy ui add` crashed on the `pithy.worker.jsonc` that
  // `pithy init` had just written, for any adopter whose resolver landed low in the range. Bisected:
  // 4.0.0 through 4.3.6 fail, 4.4.0 onward pass.
  //
  // The defect was the range, not the code. `^4.0.0` promised versions the code cannot run on, and a
  // range is a promise about every version in it — which is why this is a floor and not a pin, and why
  // it is asserted here rather than left to whoever edits a manifest next.
  it("each declares a zod floor that supports what the code assumes of it", () => {
    for (const { dir, manifest } of manifests) {
      const range = manifest.dependencies?.zod ?? manifest.devDependencies?.zod ?? manifest.peerDependencies?.zod;
      if (range === undefined) continue;
      const [major, minor] = range
        .replace(/^[^0-9]*/, "")
        .split(".")
        .map(Number);
      expect(major, `${dir} zod major`).toBe(4);
      expect(minor, `${dir} zod minor floor — see #475`).toBeGreaterThanOrEqual(4);
    }
  });

  it("each declares a license", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.license, `${dir} license`).toBeTruthy();
    }
  });

  // With no `files`, `npm publish` takes whatever git does not ignore. `@pithy-sh/core`'s first tarball
  // was 127 test files out of 264 — half of it — and every adopter would have downloaded them.
  it("each declares what it publishes", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.files, `${dir} files`).toBeDefined();
      expect(manifest.files, `${dir} files`).toContain("src");
    }
  });

  // `@pithy-sh/payments` declared a `files` field and still shipped 93 test files, because listing what
  // to include says nothing about what to leave out. The negation is the half that does the work.
  //
  // **The extension is a wildcard on purpose.** Spelled `.test.ts`, the rule missed `@pithy-sh/ui-react`
  // entirely — its tests are TSX — and eleven of them shipped while `verify-published` reported all 22
  // packages clean. A rule that names one extension only covers the packages that happen to use it.
  it("each leaves its tests out of the tarball, whatever extension they carry", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.files, `${dir} files`).toContain("!src/**/*.test.*");
    }
  });

  // The CLI resolves every capability manifest from the adopter's `node_modules/@pithy-sh/*`
  // (`capabilities/reconcile.ts`), so a capability that ships without one is invisible to `pithy add`.
  it("each ships the capability manifest the CLI reads from node_modules", () => {
    for (const { dir, manifest } of manifests) {
      if (!existsSync(join(ROOT, dir, "pithy.manifest.json"))) continue;
      expect(manifest.files, `${dir} files`).toContain("pithy.manifest.json");
    }
  });

  // Docs are part of the product, not an afterthought — and `americanEnglish.test.ts` reads a package's
  // `docs/` as prose this project publishes, which is only true while it does.
  it("each ships the docs it writes", () => {
    for (const { dir, manifest } of manifests) {
      if (!existsSync(join(ROOT, dir, "docs"))) continue;
      expect(manifest.files, `${dir} files`).toContain("docs");
    }
  });

  /**
   * Whether an entry is one that is absent at rest and correct — a build output, or the vendored
   * starter, neither of which is committed to git.
   *
   * `dist` is every package's since #476: `exports` resolves `./src/*` onto `./dist/*.js`, so all 22
   * name it, and none of them has one until `bun run build` has run. That used to be a two-name list
   * with `@pithy-sh/payments`' browser build on it, and growing it to 22 hand-written entries would
   * have made this an inventory of the workspace rather than a rule. It is a rule: anything under
   * `dist` is a build output.
   *
   * `packages/cli/templates` is the vendored starter — `prepack` copies it in and `postpack` removes
   * it, so it exists only inside a pack.
   *
   * **Exempting them here is safe because the artifact check is not exempt.** `packing.ts` asserts
   * every declared entry actually reached the tarball, and refuses a tarball carrying no `dist` at
   * all — which is the question this test cannot ask, and which the release workflow answers after it
   * builds. A `files` field naming a path that will never exist still fails, just one step later and
   * against the real thing.
   */
  function builtNotCommitted(dir: string, entry: string): boolean {
    return entry === "dist" || entry.startsWith("dist/") || `${dir}:${entry}` === "packages/cli:templates";
  }

  // `files` does not fail on a missing path, so a field can name something that is not there and pass
  // every check but this one.
  it("names nothing it does not have", () => {
    for (const { dir, manifest } of manifests) {
      for (const entry of manifest.files ?? []) {
        if (entry.startsWith("!") || builtNotCommitted(dir, entry)) continue;
        expect(existsSync(join(ROOT, dir, entry)), `${dir} files names ${entry}, which is not there`).toBe(true);
      }
    }
  });
});
