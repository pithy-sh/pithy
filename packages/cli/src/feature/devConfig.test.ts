// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorkerTarget } from "../project/workers";
import { buildDevConfig, devConfigPath, readDevConfig, scanPinnedBlocks, writeDevConfig } from "./devConfig";
import type { PortBlock } from "./ports";

const block: PortBlock = { block: 0, base: 8787, size: 10 };

describe("buildDevConfig", () => {
  test("pins one port per worker, in order, from the feature's block", () => {
    const workers: WorkerTarget[] = [
      { name: "api", dir: "/w/apps/api" },
      { name: "web", dir: "/w/apps/web" },
    ];
    const config = buildDevConfig({ branch: "feature/69-demo", block, workers });

    expect(config).toEqual({
      version: 1,
      branch: "feature/69-demo",
      ports: { index: 0, base: 8787, size: 10 },
      workers: {
        api: { port: 8787, origin: "http://localhost:8787" },
        web: { port: 8788, origin: "http://localhost:8788" },
      },
    });
  });

  test("is deterministic — the same inputs pin the same ports for the life of the feature", () => {
    const workers: WorkerTarget[] = [{ name: "api", dir: "/w" }];
    expect(buildDevConfig({ branch: "feature/69-demo", block, workers })).toEqual(
      buildDevConfig({ branch: "feature/69-demo", block, workers }),
    );
  });

  test("a second feature's block yields non-overlapping ports", () => {
    const workers: WorkerTarget[] = [{ name: "api", dir: "/w" }];
    const first = buildDevConfig({ branch: "feature/1-a", block, workers });
    const second = buildDevConfig({ branch: "feature/2-b", block: { block: 1, base: 8797, size: 10 }, workers });
    expect(first.workers.api?.port).not.toBe(second.workers.api?.port);
  });

  test("adding a worker is additive — existing workers keep their ports, even when it sorts first", () => {
    // Discovery is alphabetical, so "api" lands BEFORE "web". A positional assignment would move web 8787→8788.
    const before = buildDevConfig({ branch: "feature/69-demo", block, workers: [{ name: "web", dir: "/w/web" }] });
    expect(before.workers.web?.port).toBe(8787);

    const after = buildDevConfig({
      branch: "feature/69-demo",
      block,
      workers: [
        { name: "api", dir: "/w/api" },
        { name: "web", dir: "/w/web" },
      ],
      previous: before,
    });

    expect(after.workers.web?.port).toBe(8787); // unmoved
    expect(after.workers.api?.port).toBe(8788); // the lowest free port in the block
  });

  test("a removed worker releases its port back to the block for reuse", () => {
    const before = buildDevConfig({
      branch: "feature/69-demo",
      block,
      workers: [
        { name: "api", dir: "/w/api" },
        { name: "web", dir: "/w/web" },
      ],
    });
    expect(before.workers.web?.port).toBe(8788);

    // "api" goes away; a new worker takes its freed 8787 while web stays put.
    const after = buildDevConfig({
      branch: "feature/69-demo",
      block,
      workers: [
        { name: "jobs", dir: "/w/jobs" },
        { name: "web", dir: "/w/web" },
      ],
      previous: before,
    });

    expect(after.workers.web?.port).toBe(8788);
    expect(after.workers.jobs?.port).toBe(8787);
    expect(after.workers.api).toBeUndefined();
  });

  test("a port from outside the current block is not carried over", () => {
    const stale = buildDevConfig({
      branch: "feature/69-demo",
      block: { block: 5, base: 8837, size: 10 },
      workers: [{ name: "web", dir: "/w/web" }],
    });
    // The feature was reallocated to a different block; the old port must not survive.
    const rebuilt = buildDevConfig({
      branch: "feature/69-demo",
      block,
      workers: [{ name: "web", dir: "/w/web" }],
      previous: stale,
    });
    expect(rebuilt.workers.web?.port).toBe(8787);
  });

  test("refuses more workers than the block holds rather than spilling into the next feature's ports", () => {
    const workers: WorkerTarget[] = [
      { name: "a", dir: "/w/a" },
      { name: "b", dir: "/w/b" },
      { name: "c", dir: "/w/c" },
    ];
    expect(() => buildDevConfig({ branch: "feature/1-a", block: { block: 0, base: 8787, size: 2 }, workers })).toThrow(
      /block holds only 2/,
    );
  });
});

describe("readDevConfig / writeDevConfig", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-devconfig-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("round-trips through the file", async () => {
    const path = devConfigPath(dir);
    expect(path).toBe(join(dir, ".dev.config.json"));

    const config = buildDevConfig({ branch: "feature/69-demo", block, workers: [{ name: "api", dir }] });
    await writeDevConfig(path, config);
    expect(await readDevConfig(path)).toEqual(config);
    expect(await readFile(path, "utf8")).toMatch(/\n$/); // trailing newline
  });

  test("a missing file reads as null", async () => {
    expect(await readDevConfig(devConfigPath(dir))).toBeNull();
  });

  test("corrupt JSON fails with an actionable error", async () => {
    const path = devConfigPath(dir);
    await writeFile(path, "{ not json");
    await expect(readDevConfig(path)).rejects.toBeInstanceOf(PithyError);
  });

  test("a structurally invalid config fails validation on read", async () => {
    const path = devConfigPath(dir);
    await writeFile(path, JSON.stringify({ version: 1, branch: "x" }));
    await expect(readDevConfig(path)).rejects.toBeInstanceOf(PithyError);
  });
});

describe("scanPinnedBlocks", () => {
  let mainRoot: string;
  beforeEach(async () => {
    mainRoot = await mkdtemp(join(tmpdir(), "pithy-scan-"));
  });
  afterEach(async () => {
    await rm(mainRoot, { recursive: true, force: true });
  });

  /** Write a worktree holding a pinned block, as `pithy feature create` would have left it. */
  async function pin(dirName: string, branch: string, block: PortBlock): Promise<void> {
    const wt = join(mainRoot, ".worktrees", dirName);
    await mkdir(wt, { recursive: true });
    await writeDevConfig(devConfigPath(wt), buildDevConfig({ branch, block, workers: [{ name: "app", dir: wt }] }));
  }

  test("returns every block pinned by an existing worktree", async () => {
    await pin("12-auth", "feature/12-auth", { block: 0, base: 8787, size: 10 });
    await pin("34-email", "feature/34-email", { block: 1, base: 8797, size: 10 });

    const found = await scanPinnedBlocks(mainRoot);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({ branch: "feature/12-auth", block: { block: 0, base: 8787, size: 10 } });
    expect(found).toContainEqual({ branch: "feature/34-email", block: { block: 1, base: 8797, size: 10 } });
  });

  test("no .worktrees directory yields nothing to reclaim", async () => {
    expect(await scanPinnedBlocks(mainRoot)).toEqual([]);
  });

  test("skips an unreadable or malformed worktree config rather than failing the scan", async () => {
    await pin("12-auth", "feature/12-auth", { block: 0, base: 8787, size: 10 });
    const broken = join(mainRoot, ".worktrees", "99-broken");
    await mkdir(broken, { recursive: true });
    await writeFile(devConfigPath(broken), "{ not json");

    expect(await scanPinnedBlocks(mainRoot)).toEqual([
      { branch: "feature/12-auth", block: { block: 0, base: 8787, size: 10 } },
    ]);
  });
});
