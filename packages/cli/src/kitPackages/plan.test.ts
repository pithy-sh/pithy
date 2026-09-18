// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { planPackages, readPackagePlan } from "./plan";
import type { DeclaredSpec } from "./ranges";
import type { Packument, RegistryFetch, RegistryResponse } from "./registry";

/** A packument publishing `versions`, `latest` last unless named. */
function packument(name: string, versions: string[], latest = versions[versions.length - 1] ?? "0.0.0"): Packument {
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        {
          version,
          dist: { tarball: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: "sha512-AA==" },
        },
      ]),
    ),
  };
}

const spec = (
  name: string,
  value: string,
  manifest = "package.json",
  field: DeclaredSpec["field"] = "dependencies",
) => ({
  name,
  manifest,
  field,
  spec: value,
});

const plan = (
  specs: DeclaredSpec[],
  packuments: Packument[],
  options: { latest?: boolean; linked?: string[]; installed?: string | null } = {},
) =>
  planPackages({
    specs,
    packuments: new Map(packuments.map((doc) => [doc.name, doc])),
    latest: options.latest ?? false,
    isLinked: (declared) => (options.linked ?? []).includes(declared.name),
    installed: () => (options.installed === undefined ? "0.2.0" : options.installed),
  });

const UI = "@pithy-sh/ui-react";

describe("planPackages", () => {
  test("^0.2.0 moves to ^0.2.3 and holds 0.3.1 as breaking — a new 0.x minor", () => {
    const result = plan([spec(UI, "^0.2.0")], [packument(UI, ["0.2.0", "0.2.3", "0.3.1"])]);
    expect(result.moves).toEqual([
      { name: UI, manifest: "package.json", field: "dependencies", from: "^0.2.0", to: "^0.2.3", target: "0.2.3" },
    ]);
    expect(result.held).toEqual([
      {
        name: UI,
        manifest: "package.json",
        range: "^0.2.0",
        installed: "0.2.0",
        latest: "0.3.1",
        reason: "breaking",
        command: "pithy upgrade --packages --latest",
      },
    ]);
  });

  test("^1.2.0 with 2.0.0 published is held as breaking — a new major", () => {
    const result = plan([spec("@pithy-sh/auth", "^1.2.0")], [packument("@pithy-sh/auth", ["1.2.0", "2.0.0"])], {
      installed: "1.2.0",
    });
    expect(result.moves).toEqual([]);
    expect(result.held).toMatchObject([{ name: "@pithy-sh/auth", latest: "2.0.0", reason: "breaking" }]);
  });

  test("an exact pin behind a patch is held as outside-range, not as breaking", () => {
    const result = plan([spec("@pithy-sh/auth", "0.2.0")], [packument("@pithy-sh/auth", ["0.2.0", "0.2.3"])]);
    expect(result.moves).toEqual([]);
    expect(result.held).toMatchObject([{ range: "0.2.0", latest: "0.2.3", reason: "outside-range" }]);
  });

  test("~1.2.0 against 1.3.0 is outside-range", () => {
    const result = plan([spec("@pithy-sh/auth", "~1.2.0")], [packument("@pithy-sh/auth", ["1.2.0", "1.3.0"])]);
    expect(result.held).toMatchObject([{ reason: "outside-range" }]);
  });

  test("--latest moves every held entry, keeps the operator, and keeps a pin exact", () => {
    const result = plan(
      [spec(UI, "^0.2.0"), spec("@pithy-sh/auth", "0.2.0", "apps/board/package.json")],
      [packument(UI, ["0.2.0", "0.2.3", "0.3.1"]), packument("@pithy-sh/auth", ["0.2.0", "0.3.1"])],
      { latest: true },
    );
    expect(result.held).toEqual([]);
    expect(result.moves).toEqual([
      { name: UI, manifest: "package.json", field: "dependencies", from: "^0.2.0", to: "^0.3.1", target: "0.3.1" },
      {
        name: "@pithy-sh/auth",
        manifest: "apps/board/package.json",
        field: "dependencies",
        from: "0.2.0",
        to: "0.3.1",
        target: "0.3.1",
      },
    ]);
  });

  /**
   * **`--latest` lands only where the default move could: stable, not deprecated, published.** `dist-tags.latest`
   * is the publisher's word, and the usual window after a compromised release is a `latest` still pointing at
   * the deprecated version. Moving there because a flag said "latest" writes it into package.json.
   */
  describe("--latest never lands on a version the default move refuses", () => {
    const withMeta = (doc: Packument, version: string, deprecated: string): Packument => {
      const entry = doc.versions[version];
      if (entry) entry.deprecated = deprecated;
      return doc;
    };

    test("a deprecated latest is neither held nor moved to; the newest good version is", () => {
      const doc = withMeta(packument("@pithy-sh/auth", ["0.2.0", "0.2.3", "0.9.0", "1.0.0"]), "1.0.0", "Compromised.");
      for (const latest of [false, true]) {
        const result = plan([spec("@pithy-sh/auth", "^0.2.0")], [doc], { latest });
        expect(result.moves.map((move) => move.to)).not.toContain("^1.0.0");
      }
      expect(plan([spec("@pithy-sh/auth", "^0.2.0")], [doc], { latest: true }).moves).toMatchObject([
        { to: "^0.9.0", target: "0.9.0" },
      ]);
      expect(plan([spec("@pithy-sh/auth", "^0.2.0")], [doc]).held).toMatchObject([
        { latest: "0.9.0", reason: "breaking" },
      ]);
    });

    test("a prerelease latest is never written", () => {
      const doc = packument("@pithy-sh/auth", ["0.2.0", "1.0.0-evil"], "1.0.0-evil");
      const result = plan([spec("@pithy-sh/auth", "^0.2.0")], [doc], { latest: true });
      expect(result).toEqual({ moves: [], held: [], leftAlone: [] });
    });

    test("a latest that names no published version is never written", () => {
      const doc = packument("@pithy-sh/auth", ["0.2.0", "0.3.1"], "9.9.9");
      const result = plan([spec("@pithy-sh/auth", "^0.2.0")], [doc], { latest: true });
      expect(result.moves).toMatchObject([{ to: "^0.3.1", target: "0.3.1" }]);
    });
  });

  test("a range already at its newest admitted version neither moves nor holds", () => {
    const result = plan([spec("@pithy-sh/auth", "^0.2.3")], [packument("@pithy-sh/auth", ["0.2.0", "0.2.3"])]);
    expect(result).toEqual({ moves: [], held: [], leftAlone: [] });
  });

  test("a range ahead of latest is left where it is", () => {
    const result = plan(
      [spec("@pithy-sh/auth", "^0.4.0")],
      [packument("@pithy-sh/auth", ["0.2.0", "0.4.0", "0.5.0"], "0.3.0")],
    );
    expect(result).toEqual({ moves: [], held: [], leftAlone: [] });
  });

  test("workspace:* and a linked checkout are left alone, each with its reason", () => {
    const result = plan(
      [spec("@pithy-sh/core", "workspace:*"), spec("@pithy-sh/auth", "^0.2.0")],
      [packument("@pithy-sh/auth", ["0.2.0", "0.2.3"])],
      { linked: ["@pithy-sh/auth"] },
    );
    expect(result.moves).toEqual([]);
    expect(result.leftAlone).toEqual([
      { name: "@pithy-sh/core", manifest: "package.json", spec: "workspace:*", reason: "not-a-registry-range" },
      { name: "@pithy-sh/auth", manifest: "package.json", spec: "^0.2.0", reason: "linked" },
    ]);
  });

  test("a package in two manifests is planned per manifest, and a devDependency keeps its field", () => {
    const result = plan(
      [
        spec("@pithy-sh/auth", "^0.2.0"),
        spec("@pithy-sh/auth", "^0.2.1", "apps/board/package.json", "devDependencies"),
      ],
      [packument("@pithy-sh/auth", ["0.2.0", "0.2.1", "0.2.3"])],
    );
    expect(result.moves).toEqual([
      {
        name: "@pithy-sh/auth",
        manifest: "package.json",
        field: "dependencies",
        from: "^0.2.0",
        to: "^0.2.3",
        target: "0.2.3",
      },
      {
        name: "@pithy-sh/auth",
        manifest: "apps/board/package.json",
        field: "devDependencies",
        from: "^0.2.1",
        to: "^0.2.3",
        target: "0.2.3",
      },
    ]);
  });
});

describe("readPackagePlan", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-plan-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@pithy-sh/auth": "^0.2.0", "@pithy-sh/core": "workspace:*" } }),
    );
    await mkdir(join(dir, "apps", "board"), { recursive: true });
    await writeFile(
      join(dir, "apps", "board", "package.json"),
      JSON.stringify({ dependencies: { "@pithy-sh/auth": "^0.2.0", "@pithy-sh/ui-react": "^0.2.0" } }),
    );
    const installed = join(dir, "node_modules", "@pithy-sh", "ui-react");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: UI, version: "0.2.0" }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const registry = (docs: Record<string, Packument | null>): RegistryFetch =>
    vi.fn(async (url: string): Promise<RegistryResponse> => {
      const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
      const doc = docs[name];
      return {
        ok: doc !== null && doc !== undefined,
        status: doc ? 200 : 404,
        json: async () => doc,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

  test("reads the declarations, fetches each managed package once, and reads the installed version", async () => {
    const fetch = registry({
      "@pithy-sh/auth": packument("@pithy-sh/auth", ["0.2.0", "0.2.3"]),
      [UI]: packument(UI, ["0.2.0", "0.3.1"]),
    });
    const read = await readPackagePlan({ projectDir: dir, latest: false, fetch });
    expect(read.state).toBe("read");
    if (read.state !== "read") return;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(read.plan.moves.map((move) => `${move.manifest} ${move.name} ${move.to}`)).toEqual([
      "package.json @pithy-sh/auth ^0.2.3",
      "apps/board/package.json @pithy-sh/auth ^0.2.3",
    ]);
    // Found by walking up from apps/board to the root's hoisted copy.
    expect(read.plan.held).toMatchObject([{ name: UI, manifest: "apps/board/package.json", installed: "0.2.0" }]);
    expect(read.plan.leftAlone).toMatchObject([{ name: "@pithy-sh/core", reason: "not-a-registry-range" }]);
  });

  test("a checkout linked in at the root is left alone as linked, and never fetched", async () => {
    const checkout = join(dir, "checkout", "auth");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@pithy-sh/auth", version: "0.2.0" }));
    await symlink(checkout, join(dir, "node_modules", "@pithy-sh", "auth"));
    const fetch = registry({ [UI]: packument(UI, ["0.2.0", "0.3.1"]) });
    const read = await readPackagePlan({ projectDir: dir, latest: false, fetch });
    expect(read.state).toBe("read");
    if (read.state !== "read") return;
    expect(read.plan.leftAlone.filter((entry) => entry.reason === "linked").map((entry) => entry.manifest)).toEqual([
      "package.json",
      "apps/board/package.json",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("bun's isolated layout is an install, not a checkout: a Worker's link into the root store is moved", async () => {
    // `apps/board/node_modules/@pithy-sh/auth` → `<root>/node_modules/.bun/…`, which is outside the
    // Worker's own `node_modules`. Judged from the Worker, every package bun installed there read as linked.
    const store = join(dir, "node_modules", ".bun", "@pithy-sh+auth@0.2.0", "node_modules", "@pithy-sh", "auth");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "package.json"), JSON.stringify({ name: "@pithy-sh/auth", version: "0.2.0" }));
    await mkdir(join(dir, "apps", "board", "node_modules", "@pithy-sh"), { recursive: true });
    await symlink(store, join(dir, "apps", "board", "node_modules", "@pithy-sh", "auth"));
    const fetch = registry({
      "@pithy-sh/auth": packument("@pithy-sh/auth", ["0.2.0", "0.2.3"]),
      [UI]: packument(UI, ["0.2.0"]),
    });
    const read = await readPackagePlan({ projectDir: dir, latest: false, fetch });
    expect(read.state).toBe("read");
    if (read.state !== "read") return;
    expect(read.plan.leftAlone.filter((entry) => entry.reason === "linked")).toEqual([]);
    expect(read.plan.moves.map((move) => move.manifest)).toEqual(["package.json", "apps/board/package.json"]);
  });

  test("one packument that fails makes the whole step unavailable — never a partial plan", async () => {
    const fetch = registry({ "@pithy-sh/auth": packument("@pithy-sh/auth", ["0.2.0", "0.2.3"]), [UI]: null });
    const read = await readPackagePlan({ projectDir: dir, latest: false, fetch });
    expect(read.state).toBe("unavailable");
  });
});
