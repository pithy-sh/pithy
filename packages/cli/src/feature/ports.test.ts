// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocatePortBlock,
  BASE_PORT,
  freePortBlock,
  LOCK_MAX_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  type PortsRegistry,
  reclaimPortBlocks,
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
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: 10 });

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;
    expect(registry["feature/1-a"]).toEqual(block);
  });

  it("allocates the next block for a second branch", async () => {
    await allocatePortBlock({ registryPath, branch: "feature/1-a" });
    const block = await allocatePortBlock({ registryPath, branch: "feature/2-b" });
    expect(block).toEqual({ block: 1, base: BASE_PORT + 10, size: 10 });
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
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: 10 });

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
      expect(block).toEqual({ block: 0, base: BASE_PORT, size: 10 });
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
        reservations: [{ branch: "feature/1-a", block: { block: 0, base: BASE_PORT, size: 10 } }],
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
