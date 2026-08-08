// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isShippedSource, isTestFile, readSource, sourceFiles, sourcePaths } from "./sourceFiles";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pithy-source-walk-"));
});
afterEach(async () => {
  // A locked directory below is chmod 0; restore it or the removal cannot descend.
  await chmod(join(root, "locked"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** Write `contents` at `root/relative`, creating the directories above it. */
async function file(relative: string, contents = "// nothing\n"): Promise<string> {
  const path = join(root, ...relative.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return path;
}

/** Every found path, relative to the root, in posix separators. */
function named(paths: readonly string[]): string[] {
  return paths.map((path) =>
    path
      .slice(root.length + 1)
      .split(sep)
      .join("/"),
  );
}

describe("sourcePaths — what the walk keeps", () => {
  test("every shipped `.ts` in the tree, by default", async () => {
    await file("a.ts");
    await file("deep/nested/b.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts", "deep/nested/b.ts"]);
  });

  test("not a test file, and not a declaration file", async () => {
    await file("a.ts");
    await file("a.test.ts");
    await file("a.d.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("nor anything that is not TypeScript at all", async () => {
    await file("a.ts");
    await file("readme.md");
    await file("config.json");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("the test files instead, when that is what is asked for", async () => {
    await file("a.ts");
    await file("a.test.ts");
    expect(named(sourcePaths(root, { keep: isTestFile }))).toEqual(["a.test.ts"]);
  });

  test("sorted, so a gate's answer does not depend on the order the filesystem hands them back", async () => {
    await file("z.ts");
    await file("a.ts");
    await file("m/n.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts", "m/n.ts", "z.ts"]);
  });
});

describe("sourcePaths — what the walk never descends into", () => {
  test("dependencies, build output and coverage", async () => {
    await file("a.ts");
    for (const directory of ["node_modules", "dist", "coverage"]) await file(`${directory}/b.ts`);
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  /**
   * The race in #185. `packages/cli/.smoke-*` and `.e2e-*` are whole scaffolded projects that other
   * suites create and delete while this walk runs, so a walk that descends into one collects paths that
   * are gone before they can be read — `ENOENT … packages/cli/.smoke-OXGbGb/pithy.config.ts`, observed
   * on a full-suite run. `.worktrees/` is the same shape at a larger size: a second checkout of this
   * whole repository, scanned as if it were this one.
   */
  test("nor any dotted directory — the scaffolds other suites create and delete mid-walk", async () => {
    await file("a.ts");
    await file(".smoke-abc123/pithy.config.ts");
    await file(".e2e-def456/apps/api/index.ts");
    await file(".worktrees/other-branch/packages/cli/src/b.ts");
    await file(".turbo/c.ts");
    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("except `.github`, whose scripts are source this repository ships its CI on", async () => {
    await file("a.ts");
    await file(".github/scripts/plan.ts");
    expect(named(sourcePaths(root))).toEqual([".github/scripts/plan.ts", "a.ts"]);
  });

  test("nor a directory the caller names on top of those", async () => {
    await file("a.ts");
    await file("test-utils/harness.ts");
    expect(named(sourcePaths(root, { skip: ["test-utils"] }))).toEqual(["a.ts"]);
  });

  test("nor through a symlinked directory, which is another tree wearing this one's name", async () => {
    // `withFileTypes` reports a link as a link, not as the directory it points at. Following one would
    // walk `node_modules/<pkg>` back into a package already walked, and loop on a link to an ancestor.
    await file("real/a.ts");
    await symlink(join(root, "real"), join(root, "linked"));
    expect(named(sourcePaths(root))).toEqual(["real/a.ts"]);
  });
});

/**
 * The half of #185 that hardening buys and moving the scaffolds cannot: the tree is not still while the
 * walk runs. Six tripwires in this repository read source across the whole tree, and any one of them can
 * be walking `packages/cli` at the moment another suite tears its scaffold down. A gate that fails on
 * somebody else's teardown is a gate people learn to re-run, and then to mute.
 */
describe("sourcePaths — a tree that changes while it is being read", () => {
  test("a directory it cannot read is skipped, not fatal", async () => {
    // Stands in for a directory removed between its parent being listed and it being opened, which is
    // the same `readdirSync` throw. Relies on the suite not running as root, where chmod does nothing.
    await file("a.ts");
    await file("locked/b.ts");
    await chmod(join(root, "locked"), 0o000);

    expect(named(sourcePaths(root))).toEqual(["a.ts"]);
  });

  test("a file that vanished between the listing and the read is skipped, not fatal", async () => {
    const gone = await file("gone.ts", "export const x = 1;\n");
    await file("stays.ts", "export const y = 2;\n");
    // The listing happened; the file did not survive to the read.
    const listed = sourcePaths(root);
    expect(named(listed)).toEqual(["gone.ts", "stays.ts"]);
    await rm(gone);

    expect(readSource(gone)).toBeNull();
    expect(sourceFiles(root).map((source) => source.text)).toEqual(["export const y = 2;\n"]);
  });

  test("a root that is not there at all is empty rather than a throw", () => {
    expect(sourcePaths(join(root, "not-here"))).toEqual([]);
  });
});

describe("sourceFiles", () => {
  test("hands back each file with the text it held, in the same order", async () => {
    await file("a.ts", "first\n");
    await file("b.ts", "second\n");
    expect(sourceFiles(root)).toEqual([
      { path: join(root, "a.ts"), text: "first\n" },
      { path: join(root, "b.ts"), text: "second\n" },
    ]);
  });
});

describe("the predicates a caller picks between", () => {
  test("shipped source is a `.ts` that is neither a test nor a declaration", () => {
    expect(isShippedSource("scaffold.ts")).toBe(true);
    expect(isShippedSource("scaffold.test.ts")).toBe(false);
    expect(isShippedSource("scaffold.workers.test.ts")).toBe(false);
    expect(isShippedSource("globals.d.ts")).toBe(false);
    expect(isShippedSource("wrangler.jsonc")).toBe(false);
  });

  test("a test file is a `.test.ts`, whatever else its name carries", () => {
    expect(isTestFile("scaffold.test.ts")).toBe(true);
    expect(isTestFile("worker.workers.test.ts")).toBe(true);
    expect(isTestFile("scaffold.ts")).toBe(false);
  });
});
