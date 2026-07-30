// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Both are symlinks pointing at the shared file — not copies.
    for (const target of [join(worktreePath, ".dev.vars"), join(apiDir, ".dev.vars")]) {
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readlink(target)).toBe(source);
      expect(await readFile(target, "utf8")).toBe("SECRET=abc\n");
    }

    // Editing the shared file propagates everywhere — the point of sharing rather than copying.
    await writeFile(source, "SECRET=rotated\n");
    expect(await readFile(join(apiDir, ".dev.vars"), "utf8")).toBe("SECRET=rotated\n");
  });

  test("replaces a stale file or link at a target so a re-run re-points it", async () => {
    await writeFile(join(mainRoot, ".dev.vars"), "SECRET=abc\n");
    await writeFile(join(worktreePath, ".dev.vars"), "STALE=1\n");

    await wireFeatureDevVars({ mainRoot, worktreePath, workers: [{ name: "app", dir: worktreePath }] });

    const target = join(worktreePath, ".dev.vars");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("SECRET=abc\n");
  });

  test("no-ops when the main checkout has no .dev.vars", async () => {
    const result = await wireFeatureDevVars({ mainRoot, worktreePath, workers: [{ name: "app", dir: worktreePath }] });
    expect(result).toEqual({ source: null, wired: [] });
    await expect(lstat(join(worktreePath, ".dev.vars"))).rejects.toThrow();
  });
});
