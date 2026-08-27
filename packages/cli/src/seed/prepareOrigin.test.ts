// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineSeed, type SeedPrepareContext } from "@pithy-sh/core/src/seed/seed";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildDevConfig, devConfigPath, readDevConfig, writeDevConfig } from "../feature/devConfig";
import { allocatePortBlock } from "../feature/ports";
import type { WorkerScope } from "../migrations/run";
import { seedProject } from "./run";

/**
 * The origin a prepared set is handed, driven end to end against real port allocations.
 *
 * Its own file, and the reason is the whole point of the issue: every other seed suite runs inside one
 * temp project, and this one needs **two**. A single checkout can hold a hard-coded `http://localhost:8787`
 * and never notice, which is exactly how `DEV_ORIGIN` survived in the dashboard's dev seed. Two checkouts
 * allocating from one machine-wide registry is the smallest thing the defect cannot pass.
 *
 * No port literal appears in an assertion anywhere below. Each expectation is read back off the config the
 * allocator actually wrote, so a resolver that returns a constant fails even when the constant is right.
 */

/** A capability whose only set captures the context and writes nothing. No stores, so no run boots workerd. */
function originCapability(seen: SeedPrepareContext[], environments: readonly string[] = ["dev"]): Capability {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    seeds: [
      defineSeed({
        name: "self",
        order: 1000,
        environments,
        prepare: async (context) => {
          seen.push(context);
          return {};
        },
      }),
    ],
  });
}

/** One throwaway project root holding a single Worker whose `wrangler.jsonc` declares no bindings. */
interface Checkout {
  /** The project root — what `seedProject` reads `.dev.config.json` from. */
  dir: string;
  /** The project's one Worker, composing `capabilities`. */
  worker: (capabilities: Capability[]) => WorkerScope;
}

describe("the origin a prepared set is given", () => {
  const made: string[] = [];
  let registryPath = "";

  async function checkout(): Promise<Checkout> {
    const dir = await mkdtemp(join(tmpdir(), "pithy-seed-origin-"));
    made.push(dir);
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{}");
    return { dir, worker: (capabilities) => ({ name: "api", dir: workerDir, capabilities }) };
  }

  /** Allocate a real port block for this checkout and pin its Worker, exactly as `pithy feature create` does. */
  async function allocate(target: Checkout, branch: string): Promise<void> {
    const block = await allocatePortBlock({ registryPath, root: target.dir, branch });
    await writeDevConfig(
      devConfigPath(target.dir),
      buildDevConfig({ branch, block, workers: [{ name: "api", dir: join(target.dir, "apps", "api") }] }),
    );
  }

  /** Seed the checkout and hand back every context its prepared set saw. */
  async function seedAndCapture(
    target: Checkout,
    options: { env?: string; environments?: readonly string[] } = {},
  ): Promise<SeedPrepareContext[]> {
    const seen: SeedPrepareContext[] = [];
    const env = options.env ?? "dev";
    await seedProject({
      account: null,
      project: "acme",
      projectDir: target.dir,
      env,
      ...(env === "dev" ? {} : { yes: true }),
      workers: [target.worker([originCapability(seen, options.environments)])],
    });
    return seen;
  }

  /** What the allocator wrote for this checkout's one Worker — the only source an assertion compares against. */
  async function pinned(target: Checkout): Promise<string | undefined> {
    return (await readDevConfig(devConfigPath(target.dir)))?.workers.api?.origin;
  }

  beforeEach(async () => {
    const registryDir = await mkdtemp(join(tmpdir(), "pithy-seed-origin-registry-"));
    made.push(registryDir);
    registryPath = join(registryDir, "dev-ports.json");
  });

  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("two checkouts seeding one set each see the origin their own allocation pinned", async () => {
    const a = await checkout();
    const b = await checkout();
    // Two real allocations against one machine-wide registry, so the second block cannot overlap the first.
    await allocate(a, "feature/1-a");
    await allocate(b, "feature/2-b");

    const seenA = await seedAndCapture(a);
    const seenB = await seedAndCapture(b);

    expect(seenA[0]?.origin).toBe(await pinned(a));
    expect(seenB[0]?.origin).toBe(await pinned(b));
    // The issue in one line: one set, two checkouts, two origins. A literal passes neither side of this.
    expect(seenA[0]?.origin).not.toBe(seenB[0]?.origin);
  });

  test("is the allocator's own string, never recomposed from the port", async () => {
    const target = await checkout();
    // A config whose origin disagrees with its port. `buildDevConfig` mints the pair in one place; anything
    // that mints it a second time here answers 8787 and fails.
    await writeDevConfig(devConfigPath(target.dir), {
      version: 1,
      branch: "feature/3-c",
      ports: { index: 0, base: 8787, size: 20 },
      workers: { api: { port: 8787, origin: "http://localhost:9999" } },
    });

    const seen = await seedAndCapture(target);

    expect(seen[0]?.origin).toBe("http://localhost:9999");
  });

  test("is null in a checkout that has never been allocated a port block", async () => {
    const seen = await seedAndCapture(await checkout());

    expect(seen[0]?.origin).toBeNull();
  });

  test("is null for a Worker the allocation does not name", async () => {
    const target = await checkout();
    // The block pins `web`, and the run seeds `api` — a Worker added after the block was pinned.
    await writeDevConfig(devConfigPath(target.dir), {
      version: 1,
      branch: "feature/4-d",
      ports: { index: 0, base: 8787, size: 20 },
      workers: { web: { port: 8787, origin: "http://localhost:8787" } },
    });

    const seen = await seedAndCapture(target);

    expect(seen[0]?.origin).toBeNull();
  });

  test("is null outside dev, whatever the checkout pinned", async () => {
    const target = await checkout();
    await allocate(target, "feature/5-e");

    const seen = await seedAndCapture(target, { env: "staging", environments: ["dev", "staging"] });

    // A deployed environment's address is declared rather than allocated, so the local pin is not an answer.
    expect(seen[0]?.origin).toBeNull();
    expect(await pinned(target)).toBeDefined();
  });

  test("is null when the dev config is corrupt, rather than failing a run that never needed it", async () => {
    const target = await checkout();
    await writeFile(devConfigPath(target.dir), "{");

    // Almost every project composes a prepared set, so a hand-edited trailing comma must not abort a seed
    // mid fan-out over a value most sets never read. `pithy dev` is what genuinely needs this file, and it
    // still refuses.
    const seen = await seedAndCapture(target);

    expect(seen[0]?.origin).toBeNull();
  });
});
