// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { sourcePaths } from "./sourceFiles";

/**
 * **The CLI's Windows tests run on a Windows runner, and only there** (#702).
 *
 * CI ran on Linux alone, so nothing the CLI does on Windows was checked by anything — #698 shipped that
 * way, with every `pithy add` dying on `ENOENT` and every check green. Running the whole suite on Windows
 * would roughly double every pull request's wall time to test the Workers suites, the clean room and the
 * Node matrix, none of which varies by operating system. So the set is small and named:
 *
 * - **`*.windows.test.ts` is a test that has to touch the real platform to prove anything** — a real
 *   `.cmd`, a real `%APPDATA%`, a filename Windows refuses. A test that passes `"win32"` into a function
 *   already runs everywhere and is not one.
 * - **`vitest.windows.config.ts` runs exactly that set, and the default config never does.** A Windows
 *   fact asserted on Linux is a red test that proves nothing, and a Windows test the Linux run picks up
 *   is one that will be "fixed" by being made to pass there.
 * - **Each one refuses to run off Windows**, so a job that lands on the wrong runner fails rather than
 *   passing on nothing.
 * - **`ci.yml`'s `windows` job runs it, on `windows-*`, under the Node floor**, only when `plan` says the
 *   CLI or a package it depends on changed. `mainRuleset.test.ts` already holds `CI` to needing it.
 *
 * `ci.yml` is read as text, for the reason `mainRuleset.test.ts` gives.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = resolve(REPO_ROOT, "packages", "cli");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");

const WINDOWS_GLOBS = ["src/**/*.windows.test.ts", "src/**/*.windows.test.tsx"];

interface TestConfig {
  test?: { include?: string[]; exclude?: string[] };
}

async function loadConfig(file: string): Promise<TestConfig> {
  const module = (await import(pathToFileURL(resolve(CLI, file)).href)) as { default: TestConfig };
  return module.default;
}

/**
 * The lines of one top-level job in a workflow: from its key to the next key at the same depth, less the
 * comment block that introduces the next job — that prose is about the job below, and a phrase in it must
 * not satisfy, or fail, an assertion about this one.
 */
function jobBlock(workflow: string, key: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${key}:`);
  if (start === -1) return "";
  let end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  if (end === -1) end = lines.length;
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1] ?? "")) end -= 1;
  return lines.slice(start, end).join("\n");
}

interface Manifest {
  scripts: Record<string, string>;
  engines: { node: string };
}

/**
 * The CLI's Node floor, exactly: `>=22.18.0` is `22.18.0`. The Windows job runs the floor itself, not the
 * newest release in its line — `.cmd` handling changed inside a release line once (CVE-2024-27980), and an
 * adopter on the floor is the one who meets the difference.
 */
function nodeFloor(manifest: Manifest): string {
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(manifest.engines.node.trim())?.[1];
  if (!floor) throw new Error(`Cannot read an exact Node floor from "${manifest.engines.node}".`);
  return floor;
}

let workflow: string;
let manifest: Manifest;
let windowsTests: string[];

beforeAll(async () => {
  workflow = await readFile(CI_WORKFLOW, "utf8");
  manifest = JSON.parse(await readFile(resolve(CLI, "package.json"), "utf8")) as Manifest;
  windowsTests = sourcePaths(resolve(CLI, "src"), { keep: (name) => /\.windows\.test\.tsx?$/.test(name) }).map((path) =>
    relative(CLI, path),
  );
});

describe("the Windows test set", () => {
  test("the default run excludes it", async () => {
    expect((await loadConfig("vitest.config.ts")).test?.exclude).toEqual(expect.arrayContaining(WINDOWS_GLOBS));
  });

  test("the Windows config runs it and nothing else", async () => {
    expect((await loadConfig("vitest.windows.config.ts")).test?.include).toEqual(WINDOWS_GLOBS);
  });

  test("has tests in it, so the job cannot pass on an empty set", () => {
    expect(windowsTests.length).toBeGreaterThan(0);
  });

  test("every one refuses to run anywhere but Windows: it imports the guard and calls it at the top level", async () => {
    for (const file of windowsTests) {
      const source = await readFile(resolve(CLI, file), "utf8");
      expect(source, file).toMatch(/^import \{ requireWindows \} from "(\.\.\/)+test-utils\/windows";$/m);
      expect(source, file).toMatch(/^requireWindows\(\);$/m);
    }
  });

  test("is a package script, so the job runs one command", () => {
    expect(manifest.scripts["test:windows"]).toBe("vitest run --config vitest.windows.config.ts");
  });
});

describe("the windows job", () => {
  test("ends at its own last line, not at the next job's introduction", () => {
    const fixture = ["jobs:", "  a:", "    runs-on: x", "", "  # about b", "  b:", "    runs-on: y"].join("\n");
    expect(jobBlock(fixture, "a")).toBe(["  a:", "    runs-on: x"].join("\n"));
  });

  test("runs on a Windows runner", () => {
    expect(jobBlock(workflow, "windows")).toMatch(/^ {4}runs-on: windows-\d{4}\s*$/m);
  });

  test("runs only when plan says the CLI could have changed", () => {
    expect(jobBlock(workflow, "windows")).toMatch(/^ {4}needs: plan\s*$/m);
    expect(jobBlock(workflow, "windows")).toMatch(/^ {4}if: needs\.plan\.outputs\.windows == 'true'\s*$/m);
  });

  test("plan publishes that answer from the affected package set", () => {
    expect(jobBlock(workflow, "plan")).toMatch(/^ {6}windows: \$\{\{ steps\.plan\.outputs\.windows \}\}\s*$/m);
    expect(jobBlock(workflow, "plan")).toContain('echo "windows=');
  });

  test("runs the Windows set under the Node floor exactly, and nothing else", () => {
    const block = jobBlock(workflow, "windows");
    expect(block).toContain(`node-version: "${nodeFloor(manifest)}"`);
    expect(block).toContain("node --run test:windows");
    expect(block).not.toMatch(/turbo run test|node --run test:node|bun run test\b/);
  });
});
