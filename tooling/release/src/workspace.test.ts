// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishedPackages, publishedVersions, WORKSPACE_AREAS } from "./workspace";

describe("publishedVersions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pithy-workspace-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function pkg(area: string, dir: string, manifest: Record<string, unknown>): void {
    mkdirSync(join(root, area, dir), { recursive: true });
    writeFileSync(join(root, area, dir, "package.json"), JSON.stringify(manifest));
  }

  it("reads every publishable package's version", () => {
    pkg("packages", "auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    pkg("packages", "core", { name: "@pithy-sh/core", version: "1.5.0" });

    expect([...publishedVersions(root)]).toEqual([
      ["@pithy-sh/auth", "1.4.1"],
      ["@pithy-sh/core", "1.5.0"],
    ]);
  });

  // `tooling/*` is repo machinery. It is in the workspace, it is versioned at 0.0.0 forever, and it is
  // never published — so a record for it would tell an adopter about a package they cannot install.
  it("ignores a private package", () => {
    pkg("packages", "auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    pkg("tooling", "release", { name: "@pithy-sh/release", version: "0.0.0", private: true });

    expect([...publishedVersions(root).keys()]).toEqual(["@pithy-sh/auth"]);
  });

  it("reads packages across every workspace area", () => {
    pkg("packages", "auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    pkg("tooling", "public-tool", { name: "@pithy-sh/public-tool", version: "2.0.0" });

    expect([...publishedVersions(root).keys()]).toEqual(["@pithy-sh/auth", "@pithy-sh/public-tool"]);
  });

  it("skips a directory that holds no manifest", () => {
    pkg("packages", "auth", { name: "@pithy-sh/auth", version: "1.4.1" });
    mkdirSync(join(root, "packages", "not-a-package"), { recursive: true });

    expect([...publishedVersions(root).keys()]).toEqual(["@pithy-sh/auth"]);
  });

  it("is empty when the workspace has no packages at all", () => {
    expect([...publishedVersions(root)]).toEqual([]);
  });

  // The directory is read, never derived from the name. Derived, `replay` would skip this package's
  // changelog in silence — the under-reporting the whole mechanism exists to prevent.
  it("reports a package's directory even when it does not match its name", () => {
    pkg("packages", "not-the-name", { name: "@pithy-sh/auth", version: "1.4.1" });

    expect(publishedPackages(root)).toEqual([
      { name: "@pithy-sh/auth", version: "1.4.1", dir: "packages/not-the-name" },
    ]);
  });

  it("names the manifest it could not read", () => {
    mkdirSync(join(root, "packages", "broken"), { recursive: true });
    writeFileSync(join(root, "packages", "broken", "package.json"), "{ not json");

    expect(() => publishedVersions(root)).toThrow(/broken/);
  });

  it("refuses a manifest with no name or no version", () => {
    pkg("packages", "nameless", { version: "1.0.0" });

    expect(() => publishedVersions(root)).toThrow(/name/);
  });
});

// The areas are hard-coded, so this is what keeps them from drifting from the workspace they claim to
// describe. A new area added to the root manifest and not here would be silently unreleasable.
describe("WORKSPACE_AREAS", () => {
  it("names every area the root manifest declares", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces: string[] };
    const declared = manifest.workspaces.map((glob) => glob.replace(/\/\*$/, ""));

    expect([...WORKSPACE_AREAS].sort()).toEqual([...declared].sort());
  });

  it("reads this repo's own packages", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const versions = publishedVersions(root);

    expect(versions.has("@pithy-sh/core")).toBe(true);
    expect(versions.has("@pithy-sh/release")).toBe(false);
  });
});
