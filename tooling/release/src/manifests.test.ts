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

  // `files` does not fail on a missing path, so a field can name something that is not there and pass
  // every check but this one. `packing.ts` is the same question asked of the artifact.
  //
  // **Two entries are absent at rest and correct**, and neither is committed to git.
  //
  // `packages/cli/templates` is the vendored starter: `prepack` copies it in and `postpack` removes it,
  // so it exists only inside a pack. `packages/payments/dist/paddle-prices.iife.js` is the browser
  // build, written by that package's `build` and git-ignored, so it exists only after one has run.
  //
  // Both are why the artifact check exists rather than only this one. `packing.ts` asserts every
  // declared entry actually reached the tarball, which is the question this test cannot ask — and the
  // release workflow packs *after* it builds, so the answer there is about the real artifact.
  const BUILT_NOT_COMMITTED = new Set(["packages/cli:templates", "packages/payments:dist/paddle-prices.iife.js"]);

  it("names nothing it does not have", () => {
    for (const { dir, manifest } of manifests) {
      for (const entry of manifest.files ?? []) {
        if (entry.startsWith("!") || BUILT_NOT_COMMITTED.has(`${dir}:${entry}`)) continue;
        expect(existsSync(join(ROOT, dir, entry)), `${dir} files names ${entry}, which is not there`).toBe(true);
      }
    }
  });
});
