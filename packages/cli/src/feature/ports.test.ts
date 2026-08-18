// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import {
  allocatePortBlock,
  BASE_PORT,
  BLOCK_SIZE,
  freePortBlock,
  LOCK_MAX_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  type PortsRegistry,
  reclaimPortBlocks,
  resolvePortsRegistryPath,
} from "./ports";

describe("ports", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ports-"));
    registryPath = join(dir, ".dev-ports.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("allocates block 0 for the first branch", async () => {
    const block = await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(registry["feature/1-a"]).toEqual(block);
  });

  it("allocates the next block for a second branch", async () => {
    await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    const block = await allocatePortBlock({ registryPath, branch: "feature/2-b" });
    expect(block).toEqual({ block: 1, base: BASE_PORT + BLOCK_SIZE, size: BLOCK_SIZE });
  });

  it("is idempotent: re-allocating an existing branch returns the same block", async () => {
    const first = await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    await allocatePortBlock({ registryPath, branch: "feature/2-b" });
    const again = await allocatePortBlock({ registryPath, branch: "feature/1-a" });

    expect(again).toEqual(first);

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(Object.keys(registry).sort()).toEqual(["feature/1-a", "feature/2-b"]);
  });

  it("frees a block and reuses the lowest free index on the next allocation", async () => {
    await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    await allocatePortBlock({ registryPath, branch: "feature/2-b" });

    await freePortBlock({ registryPath, branch: "feature/1-a" });

    const block = await allocatePortBlock({ registryPath, branch: "feature/3-c" });
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(registry["feature/1-a"]).toBeUndefined();
    expect(Object.keys(registry).sort()).toEqual(["feature/2-b", "feature/3-c"]);
  });

  it("freeing a missing branch is a no-op", async () => {
    await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    await expect(freePortBlock({ registryPath, branch: "feature/nope" })).resolves.toBeUndefined();

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(Object.keys(registry)).toEqual(["feature/1-a"]);
  });

  it("freeing against a missing registry file is a no-op", async () => {
    await expect(freePortBlock({ registryPath, branch: "feature/nope" })).resolves.toBeUndefined();
  });

  it("honors a custom block size", async () => {
    const first = await allocatePortBlock({ registryPath, branch: "feature/1-a", size: 25 });
    const second = await allocatePortBlock({ registryPath, branch: "feature/2-b", size: 25 });

    expect(first).toEqual({ block: 0, base: BASE_PORT, size: 25 });
    expect(second).toEqual({ block: 1, base: BASE_PORT + 25, size: 25 });
  });

  /**
   * The block is not sized for `apps/*` alone. `pithy dev` starts each composed capability's host
   * Worker beside them (pithy-sh/pithy#410), each with its own pinned port out of this block, so the
   * width has to cover the whole host registry and still leave a project room for its own Workers.
   * It was ten, which a default two-Worker scaffold composing the kit filled exactly — and one more
   * Worker refused to start the session at all.
   */
  it("is wide enough for every capability host plus a project's own Workers", () => {
    expect(BLOCK_SIZE).toBeGreaterThanOrEqual(HOST_WORKERS.length + 4);
  });

  it("never overlaps a block of a different width already in the registry", async () => {
    // A registry written before the width changed keeps its own entries verbatim, so one allocation
    // can meet another of a different size. Index arithmetic alone would put a wide block 2 straight
    // through a narrow block 4's ports, and two features would bind the same port.
    await writeFile(
      registryPath,
      JSON.stringify({
        "feature/1-a": { block: 0, base: BASE_PORT, size: 5 },
        "feature/2-b": { block: 2, base: BASE_PORT + 10, size: 5 },
      }),
      "utf8",
    );
    const block = await allocatePortBlock({ registryPath, branch: "feature/3-c", size: 8 });
    const taken = [
      { low: BASE_PORT, high: BASE_PORT + 5 },
      { low: BASE_PORT + 10, high: BASE_PORT + 15 },
    ];
    for (const range of taken) {
      expect(block.base < range.high && block.base + block.size > range.low).toBe(false);
    }
  });

  it("throws a PithyError when the registry file is not valid JSON", async () => {
    await writeFile(registryPath, "not json", "utf8");
    await expect(allocatePortBlock({ registryPath, branch: "feature/1-a" })).rejects.toThrow(/corrupt/i);
  });

  it("throws a PithyError when a registry entry is missing its block, instead of handing out block 0", async () => {
    // Hand-edited/half-written entry: no `block` field at all.
    await writeFile(registryPath, JSON.stringify({ "feature/1-a": { base: 8787, size: 10 } }), "utf8");
    await expect(allocatePortBlock({ registryPath, branch: "feature/2-b" })).rejects.toThrow(/corrupt/i);
  });

  it("throws a PithyError when a registry entry's block is not a number, instead of yielding NaN ports", async () => {
    await writeFile(registryPath, JSON.stringify({ "feature/1-a": { block: "zero", base: 8787, size: 10 } }), "utf8");
    await expect(allocatePortBlock({ registryPath, branch: "feature/2-b" })).rejects.toThrow(/corrupt/i);
  });

  describe("lock staleness", () => {
    const lockPath = (): string => `${registryPath}.lock`;

    it("reclaims a stale lock and lets allocation proceed", async () => {
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }), "utf8");
      const staleTime = new Date(Date.now() - LOCK_STALE_MS - 1_000);
      await utimes(lockPath(), staleTime, staleTime);

      const block = await allocatePortBlock({ registryPath, branch: "feature/1-a" });
      expect(block).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });
    });

    it("does NOT reclaim a fresh lock — allocation still fails", async () => {
      // mtime defaults to "now", well inside the staleness window, so every retry must keep failing.
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }), "utf8");

      // A budget of its own, because this test has to *exhaust* it and the production one costs
      // 50 × 100ms = exactly vitest's default timeout (#194). The rule is that a fresh lock survives a
      // spent budget; the size of the budget is not part of it, and three attempts spend one as
      // completely as fifty. ~30ms instead of ~5000, and the assertion is about the lock rather than
      // about how loaded the machine is.
      await expect(
        allocatePortBlock({ registryPath, branch: "feature/1-a", lock: { maxAttempts: 3, retryDelayMs: 10 } }),
      ).rejects.toThrow(/lock/i);

      // The fresh lock was never touched — proves this isn't an unconditional steal.
      await expect(stat(lockPath())).resolves.toBeDefined();
    });

    it("spends the production budget when no caller names one, and says how much it spent", async () => {
      // The injected budget is a test seam, so the default has to be asserted or the seam is a way for
      // production to quietly acquire a different one. Only the delay is overridden here: the attempt
      // count is left to default, and the refusal naming 50 is what proves it arrived.
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }), "utf8");

      expect(LOCK_MAX_ATTEMPTS).toBe(50);
      expect(LOCK_RETRY_DELAY_MS).toBe(100);

      const thrown = (await allocatePortBlock({
        registryPath,
        branch: "feature/1-a",
        lock: { retryDelayMs: 0 },
      }).catch((error: unknown) => error)) as PithyError;
      expect(thrown.payload.detail).toContain(`after ${LOCK_MAX_ATTEMPTS} attempts`);
    });

    it("names the budget it actually spent, not the constant it did not use", async () => {
      // A refusal reporting 50 after three attempts sends whoever reads it to the wrong number.
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }), "utf8");

      const thrown = (await allocatePortBlock({
        registryPath,
        branch: "feature/1-a",
        lock: { maxAttempts: 3, retryDelayMs: 10 },
      }).catch((error: unknown) => error)) as PithyError;
      expect(thrown.payload.detail).toContain("after 3 attempts");
    });

    it("removes the lock file after a successful operation", async () => {
      await allocatePortBlock({ registryPath, branch: "feature/1-a" });
      await expect(stat(lockPath())).rejects.toThrow();
    });
  });

  describe("reclaimPortBlocks", () => {
    it("re-registers a block a worktree still holds, so a lost registry cannot hand it out again", async () => {
      // The registry was deleted while feature/1-a's worktree (block 0) lived on.
      const reclaimed = await reclaimPortBlocks({
        registryPath,
        reservations: [{ branch: "feature/1-a", block: { block: 0, base: BASE_PORT, size: BLOCK_SIZE } }],
      });
      expect(reclaimed).toEqual(["feature/1-a"]);

      // The next feature must therefore get block 1, not the live block 0.
      const next = await allocatePortBlock({ registryPath, branch: "feature/2-b" });
      expect(next.block).toBe(1);
    });

    it("never overwrites a live allocation", async () => {
      const live = await allocatePortBlock({ registryPath, branch: "feature/1-a" });

      const reclaimed = await reclaimPortBlocks({
        registryPath,
        reservations: [{ branch: "feature/1-a", block: { block: 9, base: 9999, size: 10 } }],
      });

      expect(reclaimed).toEqual([]);
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
      expect(registry["feature/1-a"]).toEqual(live);
    });

    it("no reservations is a no-op", async () => {
      expect(await reclaimPortBlocks({ registryPath, reservations: [] })).toEqual([]);
    });
  });
});

/**
 * The two refusals that named a remedy their `catch` could not know (#217).
 *
 * `readRegistry`'s `unreadable` is every errno but `ENOENT`; `resolvePortsRegistryPath`'s `catch` is
 * reached by a `git` that is not installed as readily as by a directory that is not a repository.
 */
describe("refusals that must not assert a cause", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ports-refusal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a registry that is a directory is not a permissions problem", async () => {
    const registryPath = join(dir, ".dev-ports.json");
    await mkdir(registryPath);

    await expect(allocatePortBlock({ registryPath, branch: "feature/1-a" })).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).not.toMatch(/permission/i);
      expect(error.payload.action).toMatch(/director/i);
      return true;
    });
  });

  it("git missing from PATH is not 'run pithy from inside a git repository'", async () => {
    vi.stubEnv("PATH", join(dir, "no-such-bin"));
    try {
      await expect(resolvePortsRegistryPath(dir)).rejects.toSatisfy((error: PithyError) => {
        expect(error.payload.action).not.toMatch(/inside a git repository/i);
        expect(error.payload.action).toMatch(/git/i);
        expect(error.payload.action).toMatch(/install|PATH/i);
        return true;
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a directory outside any repository still gets the repository sentence", async () => {
    await expect(resolvePortsRegistryPath(dir)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/inside a git repository/i);
      return true;
    });
  });
});
