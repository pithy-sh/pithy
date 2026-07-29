/**
 * Plans the CI test matrix: which packages run, and how they divide across runners.
 *
 * Reads a `turbo run ... --dry=json` payload on stdin and writes one JSON object to stdout for
 * the workflow to consume as job outputs. It lives here rather than inline in the YAML because
 * the two decisions it makes — what to skip, and how to balance — are the point of the job, and
 * a file can be run against a saved payload without pushing a commit.
 *
 * Two things it gets right that the obvious YAML one-liner does not:
 *
 *   1. `--dry=json` emits a task for EVERY package, whether or not that package defines the
 *      script — the absent ones carry `command: "<NONEXISTENT>"`. Sharding the raw list hands
 *      runners packages with nothing to run (`@pithy-sh/tsconfig`, `cli`'s missing
 *      `test:workers`) and inflates the shard count, so those are dropped here.
 *   2. Shards are packed longest-first by test-file count rather than dealt alphabetically.
 *      File count is a rough proxy for cost — measured seconds-per-file spans 0.8s to 4.0s —
 *      but it is a proxy that never goes stale, and on the tree where this landed it cut the
 *      worst shard from 63.7s to 56.1s against a 47.8s ideal. A measured-weight table would
 *      reach 50.0s and start rotting the day it landed; this is the cheaper two-thirds.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A task as `turbo run --dry=json` reports it. Only the fields this planner reads. */
type DryTask = {
  /** Package name, e.g. `@pithy-sh/media`. */
  package: string;
  /** Package directory relative to the repo root, e.g. `packages/media`. */
  directory: string;
  /** The resolved script, or the literal `<NONEXISTENT>` when the package omits it. */
  command: string;
};

/** A package that has at least one of the requested scripts, with its balancing weight. */
type Runnable = {
  /** Package name, used to build the `--filter=` argument. */
  name: string;
  /** Package directory relative to the repo root — how the Node-runtime job finds the package. */
  directory: string;
  /** Test-file count — the LPT weight. */
  weight: number;
};

/** One runner's worth of work. */
type Shard = {
  /** 1-based shard number, used for the job name and cache key. */
  id: number;
  /** Human-readable package list for the job name. */
  label: string;
  /** `--filter=` arguments to pass straight to `turbo run`. */
  filters: string;
};

/** The marker `turbo` uses for a task whose package does not define the script. */
const NONEXISTENT = "<NONEXISTENT>";

/** Counts a package's test files — the LPT weight. Integration suites never run in this job. */
export function testFileCount(packageDir: string): number {
  const walk = (dir: string): number => {
    let total = 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        total += walk(path);
      } else if (entry.endsWith(".test.ts") && !entry.endsWith(".integration.test.ts")) {
        total += 1;
      }
    }
    return total;
  };
  return walk(join(packageDir, "src"));
}

/**
 * Packs packages into `count` shards, heaviest first into whichever shard is currently lightest
 * (longest-processing-time-first). Returns only non-empty shards, renumbered from 1, so a plan
 * never contains a runner with nothing to do.
 */
export function packShards(weighted: readonly Runnable[], count: number): Shard[] {
  const bins: { total: number; names: string[] }[] = Array.from({ length: Math.max(1, count) }, () => ({
    total: 0,
    names: [],
  }));
  // Tie-break on name so the plan is deterministic for a given affected set.
  const order = [...weighted].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const pkg of order) {
    const target = bins.reduce((lightest, bin) => (bin.total < lightest.total ? bin : lightest));
    target.total += pkg.weight;
    target.names.push(pkg.name);
  }
  return bins
    .filter((bin) => bin.names.length > 0)
    .map((bin, index) => ({
      id: index + 1,
      label: bin.names.map((name) => name.replace("@pithy-sh/", "")).join(", "),
      filters: bin.names.map((name) => `--filter=${name}`).join(" "),
    }));
}

/** How many shards `total` packages deserve — enough to divide the work, never more than the cap. */
export function shardCount(total: number, perShard: number, max: number): number {
  return Math.min(max, Math.max(1, Math.ceil(total / perShard)));
}

/**
 * The packages in a dry-run payload that actually have a script to run, with their weights.
 * Directories come from the payload rather than being derived from the package name, so a
 * package whose folder does not match its name still gets weighed.
 */
export function runnables(tasks: readonly DryTask[]): Runnable[] {
  const dirs = new Map<string, string>();
  for (const task of tasks) {
    if (task.command !== NONEXISTENT) dirs.set(task.package, task.directory);
  }
  return [...dirs.entries()]
    .map(([name, directory]) => ({ name, directory, weight: testFileCount(directory) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads `--name=value` from argv. Args, not env vars — nothing here is read inside a turbo task. */
function arg(name: string, fallback: number): number {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = found ? Number(found.slice(name.length + 3)) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Fails on a package that has tests but no `test:node` script to run them.
 *
 * This is the failure mode the whole design is exposed to: a package missing the script is a
 * `<NONEXISTENT>` task, gets dropped from the plan, and its tests simply never run — with every
 * shard green. It is not hypothetical; `ui-react` and `vite` landed exactly this way. A package
 * with no `vitest.config.ts` is not a candidate and is silently fine.
 */
export function assertNoSilentSkips(tasks: readonly DryTask[]): string[] {
  const runnableNames = new Set(runnables(tasks).map((pkg) => pkg.name));
  const skipped = new Map<string, string>();
  for (const task of tasks) {
    if (runnableNames.has(task.package)) continue;
    if (existsSync(join(task.directory, "vitest.config.ts"))) skipped.set(task.package, task.directory);
  }
  return [...skipped.keys()].sort();
}

function main(): void {
  const perShard = arg("per-shard", 4);
  const maxShards = arg("max-shards", 4);

  const dry = JSON.parse(readFileSync(0, "utf8")) as { tasks?: DryTask[] };
  const orphans = assertNoSilentSkips(dry.tasks ?? []);
  if (orphans.length > 0) {
    process.stderr.write(
      `These packages have a vitest.config.ts but no "test:node" script, so their tests would never run:\n` +
        `${orphans.map((name) => `  - ${name}`).join("\n")}\n` +
        `Add "test:node": "vitest run --project=node" to each package.json.\n`,
    );
    process.exit(1);
  }

  const packages = runnables(dry.tasks ?? []);
  const shards = packShards(packages, shardCount(packages.length, perShard, maxShards));

  // `any` gates the downstream jobs: a matrix built from an empty array is a workflow error, so
  // the test jobs must be skipped outright rather than handed nothing.
  process.stdout.write(
    `${JSON.stringify({
      any: packages.length > 0,
      count: packages.length,
      packages: packages.map((pkg) => pkg.name).join(" "),
      // Directories, so the Node-runtime job never has to guess a folder from a package name.
      dirs: packages.map((pkg) => pkg.directory).join(" "),
      shards,
    })}\n`,
  );
}

main();
