// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildPaddlePricesBundle } from "./paddlePricesBundle";

const run = promisify(execFile);

/** This package's root, resolved from this file so the test does not depend on the caller's cwd. */
const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What an adopter's `node_modules` actually receives.
 *
 * **The browser build is the first thing this package publishes out of `dist/`, and `dist/` is
 * gitignored** — so npm's default file set, which falls back to `.gitignore`, drops it. An `exports`
 * entry pointing at a path the tarball does not carry resolves to nothing at install time and to a
 * green build here, which is the worst pairing available: the failure belongs to whoever installed it.
 *
 * So this packs the real package and looks inside the tarball. **And it pins the `files` allowlist as
 * well, because the two packers disagree**: `bun pm pack` carries `dist/` regardless, while `npm pack` —
 * which is what `changeset publish` shells out to — falls back to `.gitignore` and drops it. `files` is
 * the one instruction both honour, so it is the only thing that makes the tarball the same either way.
 * A tarball assertion alone passes here under Bun and ships an adopter a missing file.
 */

/** Every file the packed tarball carries, relative to its `package/` root. */
let packed: string[] = [];

/** Where the tarball was unpacked. */
let workDir = "";

beforeAll(async () => {
  // `bun pm pack` reads the working tree, so the artifact has to be on disk — the same file `bun run
  // build` writes, into the same place.
  await buildPaddlePricesBundle(join(PACKAGE, "dist"));
  workDir = await mkdtemp(join(tmpdir(), "pithy-payments-pack-"));
  const tarball = join(workDir, "payments.tgz");
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
async function manifest(): Promise<{ exports: Record<string, string>; files?: string[] }> {
  return JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8")) as {
    exports: Record<string, string>;
    files?: string[];
  };
}

describe("the published tarball", () => {
  test("names its file set explicitly, and names it widely enough for every export", async () => {
    const { exports, files } = await manifest();
    const named = Object.values(exports)
      .filter((target) => !target.includes("*"))
      .map((target) => target.replace(/^\.\//, ""));

    expect(named.length).toBeGreaterThan(0);
    expect(files ?? [], "packages/payments/package.json needs a `files` allowlist").not.toEqual([]);
    for (const target of named) {
      const covered = (files ?? []).some((entry) => target === entry || target.startsWith(`${entry}/`));
      expect(covered, `no \`files\` entry covers ${target}`).toBe(true);
    }
  });

  test("carries every path its own exports map names", async () => {
    const { exports } = await manifest();
    const named = Object.values(exports).filter((target) => !target.includes("*"));

    expect(named.length).toBeGreaterThan(0);
    expect(packed).toEqual(expect.arrayContaining(named.map((target) => target.replace(/^\.\//, ""))));
  });

  test("carries the browser build", () => {
    expect(packed).toContain("dist/paddle-prices.iife.js");
  });

  test("still carries the source every other export resolves through", () => {
    expect(packed).toEqual(expect.arrayContaining(["src/client/paddlePrices.ts", "src/capability.ts", "README.md"]));
  });

  test("ships the one built file it names, and not the rest of the build directory", () => {
    // `tsc` emits the whole package into `dist/` as well, and none of it is reachable: every other
    // export resolves `./src/*` to TypeScript source. Naming `dist` wholesale in `files` doubled the
    // tarball with a second, unreferenced copy of every module.
    expect(packed.filter((file) => file.startsWith("dist/"))).toEqual(["dist/paddle-prices.iife.js"]);
  });
});
