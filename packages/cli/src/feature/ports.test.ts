// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
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
  portsRegistryPath,
  reclaimPortBlocks,
  resolveMainRepoRoot,
} from "./ports";
import { defaultGit, mainRepoRoot } from "./worktree";

describe("ports", () => {
  let dir: string;
  let registryPath: string;
  /** The checkout every single-repo test allocates for. A real directory, so the pruner never sees it as gone. */
  let root: string;

  const readRegistry = async (): Promise<PortsRegistry> =>
    JSON.parse(await readFile(registryPath, "utf8")) as PortsRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-ports-"));
    registryPath = join(dir, "dev-ports.json");
    root = join(dir, "repo");
    await mkdir(root);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("allocates block 0 for the first branch", async () => {
    const block = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });

    const registry = await readRegistry();
    expect(registry[root]?.["feature/1-a"]).toEqual(block);
  });

  it("allocates the next block for a second branch", async () => {
    await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    const block = await allocatePortBlock({ registryPath, root, branch: "feature/2-b" });
    expect(block).toEqual({ block: 1, base: BASE_PORT + BLOCK_SIZE, size: BLOCK_SIZE });
  });

  it("is idempotent: re-allocating an existing branch returns the same block", async () => {
    const first = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    await allocatePortBlock({ registryPath, root, branch: "feature/2-b" });
    const again = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });

    expect(again).toEqual(first);

    const registry = await readRegistry();
    expect(Object.keys(registry[root] ?? {}).sort()).toEqual(["feature/1-a", "feature/2-b"]);
  });

  it("frees a block and reuses the lowest free index on the next allocation", async () => {
    await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    await allocatePortBlock({ registryPath, root, branch: "feature/2-b" });

    await freePortBlock({ registryPath, root, branch: "feature/1-a" });

    const block = await allocatePortBlock({ registryPath, root, branch: "feature/3-c" });
    expect(block).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });

    const registry = await readRegistry();
    expect(registry[root]?.["feature/1-a"]).toBeUndefined();
    expect(Object.keys(registry[root] ?? {}).sort()).toEqual(["feature/2-b", "feature/3-c"]);
  });

  it("freeing a missing branch is a no-op", async () => {
    await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    await expect(freePortBlock({ registryPath, root, branch: "feature/nope" })).resolves.toBeUndefined();

    const registry = await readRegistry();
    expect(Object.keys(registry[root] ?? {})).toEqual(["feature/1-a"]);
  });

  it("freeing a branch under a root that holds none is a no-op", async () => {
    await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
    const other = join(dir, "other");
    await mkdir(other);

    await expect(freePortBlock({ registryPath, root: other, branch: "feature/1-a" })).resolves.toBeUndefined();

    const registry = await readRegistry();
    expect(registry[root]?.["feature/1-a"]).toBeDefined();
  });

  it("freeing against a missing registry file is a no-op", async () => {
    await expect(freePortBlock({ registryPath, root, branch: "feature/nope" })).resolves.toBeUndefined();
  });

  it("honors a custom block size", async () => {
    const first = await allocatePortBlock({ registryPath, root, branch: "feature/1-a", size: 25 });
    const second = await allocatePortBlock({ registryPath, root, branch: "feature/2-b", size: 25 });

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
        [root]: {
          "feature/1-a": { block: 0, base: BASE_PORT, size: 5 },
          "feature/2-b": { block: 2, base: BASE_PORT + 10, size: 5 },
        },
      }),
      "utf8",
    );
    const block = await allocatePortBlock({ registryPath, root, branch: "feature/3-c", size: 8 });
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
    await expect(allocatePortBlock({ registryPath, root, branch: "feature/1-a" })).rejects.toThrow(/corrupt/i);
  });

  it("throws a PithyError when a registry entry is missing its block, instead of handing out block 0", async () => {
    // Hand-edited/half-written entry: no `block` field at all. Nested, so the refusal is the *entry's*
    // and not the outer record's — a flat fixture would fail for the wrong reason and prove only nesting.
    await writeFile(registryPath, JSON.stringify({ [root]: { "feature/1-a": { base: 8787, size: 10 } } }), "utf8");
    await expect(allocatePortBlock({ registryPath, root, branch: "feature/2-b" })).rejects.toThrow(/corrupt/i);
  });

  it("throws a PithyError when a registry entry's block is not a number, instead of yielding NaN ports", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ [root]: { "feature/1-a": { block: "zero", base: 8787, size: 10 } } }),
      "utf8",
    );
    await expect(allocatePortBlock({ registryPath, root, branch: "feature/2-b" })).rejects.toThrow(/corrupt/i);
  });

  it("names the registry's own path in a corruption refusal, since it is nowhere anyone is standing", async () => {
    // The file left the checkout in #435, so "delete .dev-ports.json" now names a file no `ls` finds.
    await writeFile(registryPath, "not json", "utf8");
    const thrown = (await allocatePortBlock({ registryPath, root, branch: "feature/1-a" }).catch(
      (error: unknown) => error,
    )) as PithyError;
    expect(thrown.payload.action).toContain(registryPath);
  });

  /**
   * One machine, one file, every checkout on it (#435).
   *
   * The registry used to sit at each main repo root, so every project on a machine kept its own, every
   * one of them started empty, and every one of them handed out block 0 — two projects on their default
   * branch bound the same twenty ports. These are the tests for the key that fixed it.
   */
  describe("roots", () => {
    let other: string;

    beforeEach(async () => {
      other = join(dir, "other-repo");
      await mkdir(other);
    });

    it("two checkouts never overlap, even on identical branch names", async () => {
      const mine = await allocatePortBlock({ registryPath, root, branch: "main" });
      const theirs = await allocatePortBlock({ registryPath, root: other, branch: "main" });

      expect(mine.block).toBe(0);
      expect(theirs.block).toBe(1);
      expect(theirs.base).toBeGreaterThanOrEqual(mine.base + mine.size);

      const registry = await readRegistry();
      expect(Object.keys(registry).sort()).toEqual([root, other].sort());
    });

    it("keeps one checkout's branches out of another's", async () => {
      await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
      await freePortBlock({ registryPath, root: other, branch: "feature/1-a" });

      const again = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
      expect(again.block).toBe(0);
    });

    it("frees the ports of a checkout that is gone from disk", async () => {
      const gone = join(dir, "deleted-repo");
      await writeFile(
        registryPath,
        JSON.stringify({ [gone]: { main: { block: 0, base: BASE_PORT, size: BLOCK_SIZE } } }),
        "utf8",
      );

      const block = await allocatePortBlock({ registryPath, root, branch: "main" });
      expect(block.block).toBe(0);

      const registry = await readRegistry();
      expect(registry[gone]).toBeUndefined();
    });

    it("leaves a checkout that is on disk but idle exactly where it is", async () => {
      await allocatePortBlock({ registryPath, root: other, branch: "main" });

      const block = await allocatePortBlock({ registryPath, root, branch: "main" });
      expect(block.block).toBe(1);

      const registry = await readRegistry();
      expect(registry[other]?.main).toEqual({ block: 0, base: BASE_PORT, size: BLOCK_SIZE });
    });

    it("prunes on the idempotent path too, so a machine on settled branches still frees dead ports", async () => {
      // A machine whose whole steady state is `pithy dev` on an already-allocated branch never reaches
      // the allocation path. Pruning only there would let the file grow for the machine's lifetime.
      const first = await allocatePortBlock({ registryPath, root, branch: "main" });

      const gone = join(dir, "deleted-repo");
      const registry = await readRegistry();
      registry[gone] = { main: { block: 7, base: BASE_PORT + 7 * BLOCK_SIZE, size: BLOCK_SIZE } };
      await writeFile(registryPath, JSON.stringify(registry), "utf8");

      const again = await allocatePortBlock({ registryPath, root, branch: "main" });
      expect(again).toEqual(first);
      expect((await readRegistry())[gone]).toBeUndefined();
    });

    it("never prunes a checkout it merely could not stat", async () => {
      // Absence is ENOENT and nothing else. Any other errno — a repo under a mount that is not there,
      // a path whose parent stopped being a directory, an unreadable network home — would otherwise
      // delete a live checkout's whole allocation set, in one atomic write, under the lock, with the
      // reclaim scan that could rebuild it unable to run for a root the process cannot reach either.
      //
      // ENOTDIR is the portable way to ask for a non-ENOENT stat failure: no chmod, so it holds when
      // the suite runs as root, which is every container CI has.
      const blocker = join(dir, "not-a-directory");
      await writeFile(blocker, "", "utf8");
      const unstattable = join(blocker, "repo");
      await expect(stat(unstattable)).rejects.toSatisfy(
        (error: NodeJS.ErrnoException) => error.code !== undefined && error.code !== "ENOENT",
      );

      await writeFile(
        registryPath,
        JSON.stringify({ [unstattable]: { main: { block: 0, base: BASE_PORT, size: BLOCK_SIZE } } }),
        "utf8",
      );

      const block = await allocatePortBlock({ registryPath, root, branch: "main" });
      expect(block.block).toBe(1);
      expect((await readRegistry())[unstattable]).toBeDefined();
    });

    it("drops a checkout once its last branch is freed", async () => {
      await allocatePortBlock({ registryPath, root, branch: "main" });
      await freePortBlock({ registryPath, root, branch: "main" });

      expect(Object.keys(await readRegistry())).toEqual([]);
    });

    it("creates the config directory on the first allocation of a machine's life", async () => {
      // `writeFileAtomic` does not mkdir and the lock is `open(…, "wx")`, so a missing config directory
      // would ENOENT into the lock's retry loop and refuse after the full budget — naming a lock file
      // that was never created, in a directory that does not exist.
      const fresh = join(dir, "no", "such", "config", "dev-ports.json");
      const block = await allocatePortBlock({ registryPath: fresh, root, branch: "main" });
      expect(block.block).toBe(0);
      await expect(stat(fresh)).resolves.toBeDefined();
    });
  });

  describe("the config directory", () => {
    it("is created owner-only, because <config> holds cloudflare.json beside the registry", async () => {
      // On a fresh machine the first `pithy dev` can be the first thing to create `~/.config/pithy`. Every
      // other writer under this root goes through `ensureOwnerOnlyDirFor`, and a private `mkdir` here is
      // exactly the "fourth writer lands at the umask default" case `devSecrets/mode.ts` documents —
      // leaving the directory 0755 for as long as nobody happened to write a credential.
      const fresh = join(dir, "brand", "new", "config", "dev-ports.json");
      await allocatePortBlock({ registryPath: fresh, root, branch: "main" });

      const mode = (await stat(dirname(fresh))).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    });

    it("refuses with an action line rather than a raw errno when it cannot be made", async () => {
      // The rest of this module is careful to raise a PithyError with a remedy; a bare `mkdir` rejection
      // would surface through `allocatePortBlock` naming a path the operator cannot see and no way out.
      const blocker = join(dir, "occupied");
      await writeFile(blocker, "", "utf8");

      const thrown = (await allocatePortBlock({
        registryPath: join(blocker, "config", "dev-ports.json"),
        root,
        branch: "main",
      }).catch((error: unknown) => error)) as PithyError;

      expect(thrown.payload.action).toBeDefined();
      expect(thrown.payload.action).toContain("PITHY_CONFIG_DIR");
      // Not the lock's refusal: a missing directory used to spend the whole lock budget and then blame
      // a lock file that was never created.
      expect(thrown.payload.message).not.toMatch(/lock/i);
    });
  });

  describe("portsRegistryPath", () => {
    it("resolves under the injected config directory", () => {
      expect(portsRegistryPath({ env: { PITHY_CONFIG_DIR: "/tmp/pithy-config" }, platform: "linux" })).toBe(
        join("/tmp/pithy-config", "dev-ports.json"),
      );
    });

    it("resolves beside the other config files on Windows", () => {
      expect(portsRegistryPath({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, platform: "win32" })).toContain(
        "dev-ports.json",
      );
    });

    it("is undotted, so nothing hides it from the operator who has to find it", () => {
      expect(portsRegistryPath({ env: { PITHY_CONFIG_DIR: "/tmp/x" }, platform: "linux" })).not.toContain("/.dev-");
    });
  });

  describe("lock staleness", () => {
    const lockPath = (): string => `${registryPath}.lock`;

    it("reclaims a stale lock and lets allocation proceed", async () => {
      await writeFile(lockPath(), JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }), "utf8");
      const staleTime = new Date(Date.now() - LOCK_STALE_MS - 1_000);
      await utimes(lockPath(), staleTime, staleTime);

      const block = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
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
        allocatePortBlock({ registryPath, root, branch: "feature/1-a", lock: { maxAttempts: 3, retryDelayMs: 10 } }),
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
        root,
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
        root,
        branch: "feature/1-a",
        lock: { maxAttempts: 3, retryDelayMs: 10 },
      }).catch((error: unknown) => error)) as PithyError;
      expect(thrown.payload.detail).toContain("after 3 attempts");
    });

    it("removes the lock file after a successful operation", async () => {
      await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });
      await expect(stat(lockPath())).rejects.toThrow();
    });
  });

  describe("reclaimPortBlocks", () => {
    it("re-registers a block a worktree still holds, so a lost registry cannot hand it out again", async () => {
      // The config directory was wiped while feature/1-a's worktree (block 0) lived on.
      const reclaimed = await reclaimPortBlocks({
        registryPath,
        root,
        reservations: [{ branch: "feature/1-a", block: { block: 0, base: BASE_PORT, size: BLOCK_SIZE } }],
      });
      expect(reclaimed).toEqual(["feature/1-a"]);

      // The next feature must therefore get block 1, not the live block 0.
      const next = await allocatePortBlock({ registryPath, root, branch: "feature/2-b" });
      expect(next.block).toBe(1);
    });

    it("reclaims into its own checkout, never another's", async () => {
      const other = join(dir, "other-repo");
      await mkdir(other);
      await allocatePortBlock({ registryPath, root: other, branch: "feature/1-a" });

      await reclaimPortBlocks({
        registryPath,
        root,
        reservations: [{ branch: "feature/1-a", block: { block: 4, base: BASE_PORT + 4 * BLOCK_SIZE, size: 10 } }],
      });

      const registry = await readRegistry();
      expect(registry[root]?.["feature/1-a"]?.block).toBe(4);
      expect(registry[other]?.["feature/1-a"]?.block).toBe(0);
    });

    it("never overwrites a live allocation", async () => {
      const live = await allocatePortBlock({ registryPath, root, branch: "feature/1-a" });

      const reclaimed = await reclaimPortBlocks({
        registryPath,
        root,
        reservations: [{ branch: "feature/1-a", block: { block: 9, base: 9999, size: 10 } }],
      });

      expect(reclaimed).toEqual([]);
      const registry = await readRegistry();
      expect(registry[root]?.["feature/1-a"]).toEqual(live);
    });

    it("no reservations is a no-op", async () => {
      expect(await reclaimPortBlocks({ registryPath, root, reservations: [] })).toEqual([]);
    });
  });
});

/**
 * The two refusals that named a remedy their `catch` could not know (#217).
 *
 * `readRegistry`'s `unreadable` is every errno but `ENOENT`; `resolveMainRepoRoot`'s `catch` is
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
    const registryPath = join(dir, "dev-ports.json");
    await mkdir(registryPath);

    await expect(allocatePortBlock({ registryPath, root: dir, branch: "feature/1-a" })).rejects.toSatisfy(
      (error: PithyError) => {
        expect(error.payload.action).not.toMatch(/permission/i);
        expect(error.payload.action).toMatch(/director/i);
        return true;
      },
    );
  });

  it("git missing from PATH is not 'run pithy from inside a git repository'", async () => {
    vi.stubEnv("PATH", join(dir, "no-such-bin"));
    try {
      await expect(resolveMainRepoRoot(dir)).rejects.toSatisfy((error: PithyError) => {
        expect(error.payload.action).not.toMatch(/inside a git repository/i);
        expect(error.payload.action).toMatch(/git/i);
        expect(error.payload.action).toMatch(/install|PATH/i);
        return true;
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("agrees with mainRepoRoot on every spelling, which is the invariant the key rests on", async () => {
    // Self-consistency is not the property that matters. `feature create` reserves under `mainRepoRoot()`
    // (`git worktree list`) and `destroy` frees under `resolveMainRepoRoot()` (`git rev-parse
    // --git-common-dir`), so a disagreement between the two is a free that no-ops while still reporting
    // `portsFreed: true`, and a block that leaks for the life of the machine. They diverge one way per
    // platform — symlinked paths on POSIX, forward slashes on Windows — and CI runs only ubuntu, so this
    // asserts the equality itself rather than either side's shape (#435).
    const real = join(dir, "agree", "repo");
    await mkdir(real, { recursive: true });
    const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" });
    run(["init", "-q"], real);
    run(["config", "user.email", "t@t.dev"], real);
    run(["config", "user.name", "T"], real);
    run(["commit", "-q", "--allow-empty", "-m", "init"], real);
    run(["branch", "-M", "main"], real);
    const wt = join(real, ".worktrees", "1-x");
    run(["worktree", "add", "-q", "-b", "feature/1-x", wt], real);

    const link = join(dir, "agree-link");
    await symlink(join(dir, "agree"), link, "dir");

    for (const cwd of [real, wt, join(link, "repo"), join(link, "repo", ".worktrees", "1-x")]) {
      const viaCommonDir = await resolveMainRepoRoot(cwd);
      const viaWorktreeList = await mainRepoRoot((args) => defaultGit(args, cwd));
      expect(viaCommonDir).toBe(viaWorktreeList);
    }
  });

  it("answers the canonical root, so a symlinked checkout is not a second key", async () => {
    // `--git-common-dir` says `.git` in a main checkout, and resolving that against the cwd keeps whatever
    // symlinks the operator walked through — while `mainRepoRoot()` (`git worktree list`) always reports
    // the real path. As a *place to put a file* the two addressed one file through the link and the
    // difference could not be observed. As *keys* they are two entries for one repository: `pithy dev`
    // files under one and `pithy feature create` under the other, and `destroy` frees a key create never
    // wrote while still reporting `portsFreed: true`. Verified divergent before this was fixed.
    const real = join(dir, "real", "repo");
    await mkdir(real, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: real, stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "T"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);

    const link = join(dir, "link");
    await symlink(join(dir, "real"), link, "dir");

    const throughLink = await resolveMainRepoRoot(join(link, "repo"));
    const direct = await resolveMainRepoRoot(real);

    expect(throughLink).toBe(direct);
    expect(throughLink).not.toContain(`${sep}link${sep}`);
  });

  it("a directory outside any repository still gets the repository sentence", async () => {
    await expect(resolveMainRepoRoot(dir)).rejects.toSatisfy((error: PithyError) => {
      expect(error.payload.action).toMatch(/inside a git repository/i);
      return true;
    });
  });
});
