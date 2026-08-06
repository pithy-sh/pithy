// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { wireFeatureDevVars } from "./devVars";

describe("wireFeatureDevVars", () => {
  let dir: string;
  let mainRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-devvars-"));
    mainRoot = join(dir, "main");
    worktreePath = join(mainRoot, ".worktrees", "69-demo");
    await mkdir(worktreePath, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("links the worktree and every worker to the main checkout's one shared .dev.vars", async () => {
    const source = join(mainRoot, ".dev.vars");
    await writeFile(source, "SECRET=abc\n");
    const apiDir = join(worktreePath, "apps", "api");
    await mkdir(apiDir, { recursive: true });

    const workers: WorkerTarget[] = [
      { name: "app", dir: worktreePath },
      { name: "api", dir: apiDir },
    ];
    const result = await wireFeatureDevVars({ mainRoot, worktreePath, workers });

    expect(result.source).toBe(source);
    expect(new Set(result.wired)).toEqual(new Set([worktreePath, apiDir]));
    expect(result.kept).toEqual([]);

    // Both are symlinks pointing at the shared file — not copies.
    for (const target of [join(worktreePath, ".dev.vars"), join(apiDir, ".dev.vars")]) {
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("SECRET=abc\n");
    }

    // Editing the shared file propagates everywhere — the point of sharing rather than copying.
    await writeFile(source, "SECRET=rotated\n");
    expect(await readFile(join(apiDir, ".dev.vars"), "utf8")).toBe("SECRET=rotated\n");
  });

  test("replaces a stale link at a target so a re-run re-points it", async () => {
    await writeFile(join(mainRoot, ".dev.vars"), "SECRET=abc\n");
    const target = join(worktreePath, ".dev.vars");
    await writeFile(join(dir, "elsewhere"), "STALE=1\n");
    await symlink(join(dir, "elsewhere"), target);

    const result = await wireFeatureDevVars({ mainRoot, worktreePath, workers: [{ name: "app", dir: worktreePath }] });

    expect(result.wired).toEqual([worktreePath]);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("SECRET=abc\n");
  });

  test("leaves a real .dev.vars alone and reports it, rather than deleting the only copy", async () => {
    // `.dev.vars` is git-ignored, so a file replaced here is gone for good. Every caller wires *every*
    // worker it discovers, so one command touching one worker would otherwise rewrite the rest.
    await writeFile(join(mainRoot, ".dev.vars"), "SHARED=abc\n");
    const boardDir = join(worktreePath, "apps", "board");
    await mkdir(boardDir, { recursive: true });
    const own = join(boardDir, ".dev.vars");
    await writeFile(own, "BOARD_ONLY_SECRET=super-secret-value\n");

    const result = await wireFeatureDevVars({
      mainRoot,
      worktreePath,
      workers: [{ name: "board", dir: boardDir }],
    });

    expect(await readFile(own, "utf8")).toBe("BOARD_ONLY_SECRET=super-secret-value\n");
    expect((await lstat(own)).isSymbolicLink()).toBe(false);
    expect(result.kept).toEqual([boardDir]);
    expect(result.wired).toEqual([worktreePath]);
  });

  test("links relatively inside the main checkout, so moving the tree does not dangle it", async () => {
    // An absolute link breaks under `mv`, `cp -a`, rsync or a Docker context — and wrangler then reports
    // every secret ABSENT while the file sits right there.
    await writeFile(join(mainRoot, ".dev.vars"), "SECRET=abc\n");
    const apiDir = join(worktreePath, "apps", "api");
    await mkdir(apiDir, { recursive: true });

    await wireFeatureDevVars({ mainRoot, worktreePath, workers: [{ name: "api", dir: apiDir }] });

    const target = join(apiDir, ".dev.vars");
    expect(isAbsolute(await readlink(target))).toBe(false);

    const moved = join(dir, "moved");
    await rename(mainRoot, moved);
    expect(await readFile(join(moved, ".worktrees", "69-demo", "apps", "api", ".dev.vars"), "utf8")).toBe(
      "SECRET=abc\n",
    );
  });

  test("links absolutely when the target is outside the main checkout — nothing relative could reach it", async () => {
    await writeFile(join(mainRoot, ".dev.vars"), "SECRET=abc\n");
    const outside = join(dir, "outside");
    await mkdir(outside, { recursive: true });

    await wireFeatureDevVars({ mainRoot, worktreePath: outside, workers: [{ name: "app", dir: outside }] });

    const target = join(outside, ".dev.vars");
    expect(await readlink(target)).toBe(join(mainRoot, ".dev.vars"));
    expect(await readFile(target, "utf8")).toBe("SECRET=abc\n");
  });

  test("no-ops when the main checkout has no .dev.vars", async () => {
    const result = await wireFeatureDevVars({ mainRoot, worktreePath, workers: [{ name: "app", dir: worktreePath }] });
    expect(result).toEqual({ source: null, wired: [], kept: [] });
    await expect(lstat(join(worktreePath, ".dev.vars"))).rejects.toThrow();
  });
});
