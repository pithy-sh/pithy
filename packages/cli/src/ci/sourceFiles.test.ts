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
 * The one non-dotted transient, and the reason it cannot simply be dotted or moved (#192).
 *
 * `packages/cli/templates` is the copy of the repo root's `templates/starter` that `prepack` vendors in
 * and `postpack` takes out again. `files` in the CLI's manifest carries exactly that path — it is the
 * whole mechanism by which a published `@pithy-sh/cli` ships a starter (#143, #152) — so it is not
 * dotted and the dotted rule above does not reach it.
 *
 * The fixture is the two trees a pack has in flight, built in a temp root. Nothing here runs `prepack`,
 * which would put a real vendored copy under the checkout every other suite is walking.
 */
describe("sourcePaths — the vendored copy of the starter template", () => {
  /** The repo root's starter, the copy inside `packages/cli`, and one ordinary CLI source beside it. */
  async function midPack(): Promise<void> {
    for (const base of ["templates/starter", "packages/cli/templates/starter"]) {
      await file(`${base}/pithy.config.ts`);
      await file(`${base}/apps/api/src/index.ts`);
      await file(`${base}/apps/api/src/bindings.workers.test.ts`);
    }
    await file("packages/cli/src/bin.ts");
  }

  test("each template source once, whether or not a pack is in flight", async () => {
    await midPack();
    expect(named(sourcePaths(root))).toEqual([
      "packages/cli/src/bin.ts",
      "templates/starter/apps/api/src/index.ts",
      "templates/starter/pithy.config.ts",
    ]);
  });

  test("nor its tests, which CI's change planner would otherwise attribute to the CLI", async () => {
    // `crossPackageReads.ts` walks each workspace package for `*.test.ts`. The starter's own
    // `bindings.workers.test.ts` belongs to the repo root, which is not a package; through the vendored
    // copy it becomes a CLI test file, and the planner's answer changes with the pack.
    await midPack();
    expect(named(sourcePaths(root, { keep: isTestFile }))).toEqual([
      "templates/starter/apps/api/src/bindings.workers.test.ts",
    ]);
  });

  test("skipped by where it is, so a walk starting inside the package skips it too", async () => {
    await midPack();
    expect(named(sourcePaths(join(root, "packages", "cli")))).toEqual(["packages/cli/src/bin.ts"]);
  });

  test("but a `templates` directory anywhere else is source like any other", async () => {
    // By path, not by name. The copy is the only one that is a copy; the repo root's starter is the
    // source of truth the template tripwires exist to read, and a package may hold templates of its own.
    await file("templates/starter/pithy.config.ts");
    await file("packages/core/templates/a.ts");
    await file("tooling/license-headers/templates/b.ts");
    expect(named(sourcePaths(root))).toEqual([
      "packages/core/templates/a.ts",
      "templates/starter/pithy.config.ts",
      "tooling/license-headers/templates/b.ts",
    ]);
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
