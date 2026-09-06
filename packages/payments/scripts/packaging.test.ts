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
 * **Everything this package publishes now comes out of `dist/`, and `dist/` is gitignored** — so npm's
 * default file set, which falls back to `.gitignore`, drops the whole of it. An `exports` entry
 * pointing at a path the tarball does not carry resolves to nothing at install time and to a green
 * build here, which is the worst pairing available: the failure belongs to whoever installed it.
 *
 * So this packs the real package and looks inside the tarball. **And it pins the `files` allowlist as
 * well, because the two packers disagree**: `bun pm pack` carries `dist/` regardless, while `npm pack` —
 * which is what `changeset publish` shells out to — falls back to `.gitignore` and drops it. `files` is
 * the one instruction both honour, so it is the only thing that makes the tarball the same either way.
 * A tarball assertion alone passes here under Bun and ships an adopter a missing file.
 *
 * **The stake got larger with #476 and the gate did not have to change shape.** When this was written,
 * `exports` resolved `./src/*` to TypeScript and `dist/` held exactly one file — the browser IIFE — so
 * the assertion below read "ship that one and none of the rest". Every export resolves into `dist` now,
 * so the same question has the opposite answer: the build directory is the product, and the file that
 * has to be argued for individually is the IIFE, because it is the one thing in there no compiler
 * emits.
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

/** One entry in an `exports` map: a path, or a set of conditions each naming one. */
type ExportTarget = string | Record<string, string>;

/** The manifest as published. */
async function manifest(): Promise<{ exports: Record<string, ExportTarget>; files?: string[] }> {
  return JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8")) as {
    exports: Record<string, ExportTarget>;
    files?: string[];
  };
}

/**
 * Every concrete path the exports map names, wildcards dropped.
 *
 * Flattened across conditions, because `./src/*` is `{ types, default }` since #476 and each half is a
 * separate promise about a separate file. Reading only the string entries would have left the whole
 * deep-import surface unchecked while still passing — it would just have had less to check.
 */
function namedTargets(exports: Record<string, ExportTarget>): string[] {
  return Object.values(exports)
    .flatMap((target) => (typeof target === "string" ? [target] : Object.values(target)))
    .filter((target) => !target.includes("*"))
    .map((target) => target.replace(/^\.\//, ""));
}

describe("the published tarball", () => {
  test("names its file set explicitly, and names it widely enough for every export", async () => {
    const { exports, files } = await manifest();
    const named = namedTargets(exports);

    expect(named.length).toBeGreaterThan(0);
    expect(files ?? [], "packages/payments/package.json needs a `files` allowlist").not.toEqual([]);
    for (const target of named) {
      const covered = (files ?? []).some((entry) => target === entry || target.startsWith(`${entry}/`));
      expect(covered, `no \`files\` entry covers ${target}`).toBe(true);
    }
  });

  test("carries every path its own exports map names", async () => {
    const { exports } = await manifest();
    const named = namedTargets(exports);

    expect(named.length).toBeGreaterThan(0);
    expect(packed).toEqual(expect.arrayContaining(named));
  });

  test("carries the browser build", () => {
    expect(packed).toContain("dist/paddle-prices.iife.js");
  });

  test("still carries the source, which is no longer what resolves", () => {
    // Kept for source maps and go-to-definition: `dist/*.js.map` and `dist/*.d.ts.map` point back into
    // `src`, so an adopter stepping into `@pithy-sh/payments` lands on the file it was written in
    // rather than on emitted output. Nothing resolves through it any more — `exports` names `dist`.
    expect(packed).toEqual(expect.arrayContaining(["src/client/paddlePrices.ts", "src/capability.ts", "README.md"]));
  });

  test("ships a built module for every published source module, with its declaration", () => {
    // The property the old "ship one file out of `dist`" assertion became. `exports` is `./src/*`
    // mapped onto `./dist/*.js` and `./dist/*.d.ts`, so a source module with no built pair is a deep
    // import that resolves to nothing — the same install-time failure this file exists for, one
    // module at a time instead of one package at a time.
    const sources = packed.filter((file) => file.startsWith("src/") && file.endsWith(".ts") && !file.endsWith(".d.ts"));
    expect(sources.length).toBeGreaterThan(50);

    const missing = sources.flatMap((source) => {
      const stem = source.replace(/^src\//, "").replace(/\.tsx?$/, "");
      return [`dist/${stem}.js`, `dist/${stem}.d.ts`].filter((built) => !packed.includes(built));
    });
    expect(missing, "every published module needs both halves in the tarball").toEqual([]);
  });

  test("carries no test file, in either half", () => {
    // `files` negates them twice over, and both negations are load-bearing: the build glob keeps tests
    // out of `dist` and the `src` negation keeps them out of the source copy. A test in the tarball is
    // an adopter installing this repository's fixtures.
    expect(packed.filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file))).toEqual([]);
  });
});
