// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEMPLATE_DIR } from "./templates";
import { STAND_INS } from "./testing/standIns";

const run = promisify(execFile);

/** This package's root. `TEMPLATE_DIR` is `<package>/templates`. */
const PACKAGE = join(TEMPLATE_DIR, "..");

/**
 * What an app's `node_modules` receives of the native-module stand-ins.
 *
 * The tarball is packed for real and read, and the `files` allowlist is pinned beside it, because the two packers
 * disagree: `bun pm pack` carries what is on disk, while `npm pack`, which `changeset publish` runs, carries only
 * what `files` names. The allowlist is the one instruction both honor.
 */

/** Every file the packed tarball carries, relative to its `package/` root. */
let packed: string[] = [];

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pithy-ui-react-native-pack-"));
  const tarball = join(workDir, "ui-react-native.tgz");
  await run("bun", ["pm", "pack", "--quiet", "--filename", tarball], { cwd: PACKAGE });
  const { stdout } = await run("tar", ["-tzf", tarball], { encoding: "utf8" });
  packed = stdout
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""));
}, 120_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The manifest as published. */
async function manifest(): Promise<{
  files: string[];
  exports: Record<string, { types: string; default: string }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
}> {
  return JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
}

describe("the published package", () => {
  test("carries every file under testing/, and the allowlist names the directory", async () => {
    expect((await manifest()).files).toContain("testing");
    const onDisk = await readdir(join(PACKAGE, "testing"));
    expect(onDisk.length).toBeGreaterThanOrEqual(Object.keys(STAND_INS).length);
    for (const file of onDisk) expect(packed, `testing/${file}`).toContain(`testing/${file}`);
    expect(packed.filter((path) => path.startsWith("testing/") && /\.test\./.test(path))).toEqual([]);
  });

  test("carries the preset's source, whose build `./testing/vitest` names", async () => {
    expect(packed).toContain("src/testing/vitest.ts");
    expect((await manifest()).exports["./testing/vitest"]).toEqual({
      types: "./dist/testing/vitest.d.ts",
      default: "./dist/testing/vitest.js",
    });
  });

  test("exports each stand-in at its package path, as the TypeScript the alias names", async () => {
    const target = (await manifest()).exports["./testing/*"];
    expect(target).toEqual({ types: "./testing/*.ts", default: "./testing/*.ts" });
    for (const file of Object.values(STAND_INS)) {
      expect(packed, file).toContain(target?.default.replace(/^\.\//, "").replace("*.ts", file));
    }
  });

  test("asks for Vitest only as an optional peer, for the setup file that imports it", async () => {
    const { peerDependencies, peerDependenciesMeta } = await manifest();
    expect(peerDependencies.vitest).toBeDefined();
    expect(peerDependenciesMeta.vitest?.optional).toBe(true);
  });
});
