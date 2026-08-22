// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PortsRegistry } from "../feature/ports";
import { checkPortsRegistry, describePortsRegistry, type PortsRegistryOptions } from "./portsRegistry";

describe("checkPortsRegistry", () => {
  let dir: string;
  let configDir: string;
  let projectDir: string;
  let otherRoot: string;
  let goneRoot: string;

  const paths = (overrides: Partial<PortsRegistryOptions> = {}): PortsRegistryOptions => ({
    env: { PITHY_CONFIG_DIR: configDir },
    platform: "linux",
    // Stubbed in every case but the one test that is about the default: resolving it for real spawns git,
    // and a temp directory is not a repository.
    resolveRoot: async () => projectDir,
    ...overrides,
  });

  const registry = (value: PortsRegistry): Promise<void> =>
    writeFile(join(configDir, "dev-ports.json"), JSON.stringify(value), "utf8");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-doctor-ports-"));
    configDir = join(dir, "config");
    projectDir = join(dir, "project");
    otherRoot = join(dir, "other-app");
    goneRoot = join(dir, "old-thing");
    await mkdir(configDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the path even with no file, because where it would go is the answer", async () => {
    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.path).toBe(join(configDir, "dev-ports.json"));
    expect(check.present).toBe(false);
    expect(check.stray).toBeNull();
    expect(check.entries).toEqual([]);
    expect(describePortsRegistry(check)).toMatch(/no file yet/i);
  });

  it("reports the file once it is there, and then has nothing to add", async () => {
    await registry({});

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.present).toBe(true);
    // A healthy location needs no verdict — the path is the whole line.
    expect(describePortsRegistry(check)).toBeNull();
  });

  it("names a .dev-ports.json an older CLI left in the checkout", async () => {
    // The one state a developer cannot diagnose alone: the file they can see is not the file in use, and
    // editing it changes nothing (#435).
    const stray = join(projectDir, ".dev-ports.json");
    await writeFile(stray, "{}", "utf8");
    await registry({});

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.stray).toBe(stray);
    expect(describePortsRegistry(check)).toContain(stray);
  });

  it("says nothing about a directory that merely shares the name", async () => {
    await mkdir(join(projectDir, ".dev-ports.json"));

    expect((await checkPortsRegistry(projectDir, paths())).stray).toBeNull();
  });

  it("never throws, whatever the config directory turns out to be", async () => {
    // A probe that can fail the command it is diagnosing is worse than one that says less.
    const blocked = join(dir, "not-a-directory");
    await writeFile(blocked, "", "utf8");

    await expect(
      checkPortsRegistry(join(blocked, "nope"), {
        env: { PITHY_CONFIG_DIR: join(blocked, "nope") },
        platform: "linux",
        resolveRoot: async () => join(blocked, "nope"),
      }),
    ).resolves.toMatchObject({ present: false, stray: null, entries: [] });
  });

  it("lists this checkout's blocks as its own, in port order", async () => {
    await registry({
      [projectDir]: {
        "feature/12-auth": { block: 1, base: 8807, size: 20 },
        main: { block: 0, base: 8787, size: 20 },
      },
    });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.root).toBe(projectDir);
    expect(check.entries).toEqual([
      { root: projectDir, branch: "main", block: 0, base: 8787, size: 20, own: true, onDisk: true },
      { root: projectDir, branch: "feature/12-auth", block: 1, base: 8807, size: 20, own: true, onDisk: true },
    ]);
  });

  it("names the checkout that holds every other block", async () => {
    // The whole question: 8827 is taken, and this is the only place that says by what.
    await registry({
      [otherRoot]: { main: { block: 2, base: 8827, size: 20 } },
      [projectDir]: { main: { block: 0, base: 8787, size: 20 } },
    });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.entries.map((entry) => [entry.root, entry.own])).toEqual([
      [projectDir, true],
      [otherRoot, false],
    ]);
  });

  it("puts this checkout's blocks first, whatever ports the others hold", async () => {
    await registry({
      [otherRoot]: { main: { block: 0, base: 8787, size: 20 } },
      [projectDir]: { main: { block: 1, base: 8807, size: 20 } },
    });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.entries.map((entry) => entry.base)).toEqual([8807, 8787]);
  });

  it("orders two checkouts sharing a base by branch, so the row order is a fact", async () => {
    // Two roots on one base is a registry the allocator would never write, and it is exactly the shape a
    // stale mixed-width file can leave behind. A listing that reordered it between runs would read as
    // ports having moved, so the tiebreak is what makes the order something to compare against.
    await registry({
      [otherRoot]: { zulu: { block: 0, base: 8787, size: 20 } },
      [goneRoot]: { alpha: { block: 0, base: 8787, size: 20 } },
    });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.entries.map((entry) => entry.branch)).toEqual(["alpha", "zulu"]);
  });

  it("names a root that is no longer on disk, before anything prunes it", async () => {
    // Pruning cannot tell a deleted checkout from a moved one, and frees the blocks either way. A listing
    // taken before the sweep is the only thing that ever reports that it is about to happen.
    await registry({ [goneRoot]: { main: { block: 3, base: 8847, size: 20 } } });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.entries).toEqual([
      { root: goneRoot, branch: "main", block: 3, base: 8847, size: 20, own: false, onDisk: false },
    ]);
  });

  it("keeps a root it merely could not reach, on the pruner's own rule", async () => {
    // Only a definite ENOENT is absence — every other errno is this process failing to reach the path,
    // and reporting those as gone would disagree with the sweep the report is warning about.
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "", "utf8");
    const unreachable = join(blocked, "under-a-file");
    await registry({ [unreachable]: { main: { block: 0, base: 8787, size: 20 } } });

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.entries[0]?.onDisk).toBe(true);
  });

  it("reports a registry that will not parse rather than an empty one", async () => {
    // Entries would otherwise read as "nothing holds any ports", which is the opposite of the truth: a
    // corrupt registry is one `pithy dev` refuses to allocate against at all.
    await writeFile(join(configDir, "dev-ports.json"), "{ not json", "utf8");

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.present).toBe(true);
    expect(check.entries).toEqual([]);
    expect(check.unreadable).toMatch(/corrupt/i);
    expect(describePortsRegistry(check)).toContain("could not be read");
  });

  it("carries the remedy, not only the complaint", async () => {
    // The `action` is the half that names the fix, and the operator is its audience on both surfaces this
    // reaches. Dropping it told a developer their registry was corrupt and left the rest to them, while
    // the same failure through `pithy dev` named the file to delete and the command to re-run.
    await writeFile(join(configDir, "dev-ports.json"), "{ not json", "utf8");

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.unreadable).toContain(join(configDir, "dev-ports.json"));
    expect(check.unreadable).toContain("pithy feature create");
  });

  it("claims the block pithy dev filed when there is no repository at all", async () => {
    // The default is `registryRootFor`, which is the key the orchestrator allocates under: `git` first,
    // the project's own canonical path when there is no repository. Resolving only through `git` reported
    // a machine with no repo its own block as some other checkout's — `own: false` and all, which is the
    // field an agent branches on.
    const key = await realpath(projectDir);
    await registry({ [key]: { "local:x": { block: 0, base: 8787, size: 20 } } });

    const check = await checkPortsRegistry(projectDir, {
      env: { PITHY_CONFIG_DIR: configDir },
      platform: "linux",
    });

    expect(check.root).toBe(key);
    expect(check.entries.map((entry) => entry.own)).toEqual([true]);
  });

  it("owns nothing when the checkout root will not resolve", async () => {
    // Outside a repository there is no key to match on, so every block is somebody else's — which is
    // still worth printing, and is exactly what the path-only line used to withhold.
    await registry({ [otherRoot]: { main: { block: 0, base: 8787, size: 20 } } });

    const check = await checkPortsRegistry(
      projectDir,
      paths({
        resolveRoot: async () => {
          throw new Error("not a git repository");
        },
      }),
    );

    expect(check.root).toBeNull();
    expect(check.entries.map((entry) => entry.own)).toEqual([false]);
  });

  it("resolves the checkout root for real when nothing stubs it", async () => {
    // The default seam spawns git, so the contract that matters is that failing to is not a throw.
    await expect(
      checkPortsRegistry(projectDir, { env: { PITHY_CONFIG_DIR: configDir }, platform: "linux" }),
    ).resolves.toMatchObject({ entries: [] });
  });
});
