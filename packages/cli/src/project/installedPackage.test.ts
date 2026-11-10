// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installDirFor, installedPackageBase, installedVersion } from "./installedPackage";

let root: string;
let dir: string;
let worker: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-installed-"));
  dir = join(root, "project");
  worker = join(dir, "apps", "board");
  await mkdir(worker, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p", workspaces: ["apps/*"] }));
  await writeFile(join(worker, "package.json"), JSON.stringify({ name: "board" }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Put `pkg` at `version` in `base`'s own `node_modules`. */
async function put(base: string, pkg: string, version: string): Promise<void> {
  const home = join(base, "node_modules", ...pkg.split("/"));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "package.json"), JSON.stringify({ name: pkg, version }));
}

describe("installedPackageBase", () => {
  test("finds a package installed in the Worker's own node_modules", async () => {
    await put(worker, "@pithy-sh/secrets", "0.6.8");
    expect(await installedPackageBase(dir, worker, "@pithy-sh/secrets")).toBe(worker);
  });

  test("walks up to the project root when the Worker holds none", async () => {
    await put(dir, "@pithy-sh/secrets", "0.6.8");
    expect(await installedPackageBase(dir, worker, "@pithy-sh/secrets")).toBe(dir);
  });

  test("the Worker's copy wins over the root's, the way Node resolves it from there", async () => {
    await put(dir, "@pithy-sh/secrets", "0.6.7");
    await put(worker, "@pithy-sh/secrets", "0.6.8");
    expect(await installedPackageBase(dir, worker, "@pithy-sh/secrets")).toBe(worker);
  });

  test("never looks above the project root", async () => {
    await put(root, "@pithy-sh/secrets", "0.6.8");
    expect(await installedPackageBase(dir, worker, "@pithy-sh/secrets")).toBeNull();
  });

  test("a directory outside the project is not walked: only the root is asked", async () => {
    const outside = join(root, "elsewhere");
    await put(outside, "@pithy-sh/secrets", "0.6.8");
    expect(await installedPackageBase(dir, outside, "@pithy-sh/secrets")).toBeNull();
    await put(dir, "@pithy-sh/secrets", "0.6.7");
    expect(await installedPackageBase(dir, outside, "@pithy-sh/secrets")).toBe(dir);
  });

  test("an empty package directory is not an install", async () => {
    await mkdir(join(worker, "node_modules", "@pithy-sh", "secrets"), { recursive: true });
    expect(await installedPackageBase(dir, worker, "@pithy-sh/secrets")).toBeNull();
  });
});

describe("installedVersion", () => {
  test("reads the version the Worker resolves", async () => {
    await put(dir, "@pithy-sh/secrets", "0.6.7");
    await put(worker, "@pithy-sh/secrets", "0.6.8");
    expect(await installedVersion(dir, worker, "@pithy-sh/secrets")).toBe("0.6.8");
  });

  test("null when nothing is installed, or the manifest names no version", async () => {
    expect(await installedVersion(dir, worker, "@pithy-sh/secrets")).toBeNull();
    const home = join(worker, "node_modules", "@pithy-sh", "secrets");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "package.json"), "{ not json");
    expect(await installedVersion(dir, worker, "@pithy-sh/secrets")).toBeNull();
    await writeFile(join(home, "package.json"), JSON.stringify({ name: "@pithy-sh/secrets" }));
    expect(await installedVersion(dir, worker, "@pithy-sh/secrets")).toBeNull();
  });
});

describe("installDirFor", () => {
  test("a Worker that is a workspace member with its own package.json installs there", async () => {
    expect(await installDirFor(dir, worker)).toBe(worker);
  });

  test("a Worker directory holding no package.json installs at the root", async () => {
    const bare = join(dir, "apps", "bare");
    await mkdir(bare, { recursive: true });
    expect(await installDirFor(dir, bare)).toBe(dir);
  });

  test("a directory the workspace does not list installs at the root", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "p", workspaces: ["packages/*"] }));
    const tool = join(dir, "tools", "gen");
    await mkdir(tool, { recursive: true });
    await writeFile(join(tool, "package.json"), "{}");
    expect(await installDirFor(dir, tool)).toBe(dir);
  });

  test("the root itself installs at the root", async () => {
    expect(await installDirFor(dir, dir)).toBe(dir);
  });
});
