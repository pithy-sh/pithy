// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  closure,
  directoriesOf,
  inputsOf,
  NO_SCRIPT,
  type PlannedTask,
  packageOf,
  type TurboPlan,
  taskGraph,
} from "./turboGraph";

/**
 * The walk `turboInputs.test.ts` uses, and the measurement that says why it is turbo's and not ours.
 *
 * **A test that reimplements the tool it is checking drifts from that tool.** `behind()` next door used
 * to reconstruct turbo's dependency walk out of each package's manifest, and #542 moved the kit's shared
 * packages to `peerDependencies` — at which point the walk stopped following
 * `@pithy-sh/vite → @pithy-sh/core` and dropped `packages/core/src/**` out of its model of the cache key.
 * It failed loudly, which was luck: a hand-rolled model that drifts *narrow* reddens, and one that drifts
 * *wide* goes green over something turbo never hashed.
 *
 * So the walk is asked of turbo now. `--dry=json` reports, per task, the upstream task ids it depends on
 * and the files it hashes; {@link closure} follows the first and {@link inputsOf} collects the second.
 * There is no second model left to drift.
 *
 * **And the model that was replaced was wrong in both directions at once, which is measured below rather
 * than asserted.** The fixture workspace in the second block is four packages and one turbo, built four
 * times over — once per manifest field an edge can be declared in. Turbo follows `dependencies`,
 * `devDependencies` and `optionalDependencies`, and **does not follow `peerDependencies`**. That last one
 * is the opposite of what #542's fix assumed, and both halves of the drift show up in one run: told
 * `devDependencies`, the manifest walk sees nothing where turbo plans two builds; told
 * `peerDependencies`, it sees two builds where turbo plans none.
 *
 * Nothing in the kit is exposed by that today, because every `@pithy-sh/*` peerDependency in this
 * repository is also declared in a field turbo does follow — which is a property, not a coincidence, and
 * `packages/cli/src/ci/turboInputs.test.ts` holds it.
 */

/** This file's own directory. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository — `tooling/vite-adopter/src` climbed three times, spelled without a literal climb. */
const REPO_ROOT = dirname(dirname(dirname(HERE)));

/** The workspace's turbo. The fixture workspaces below are planned by the same binary this repo uses. */
const TURBO = join(REPO_ROOT, "node_modules", ".bin", "turbo");

/** One task, spelled out. Every field the derivation reads, and nothing it does not. */
function planned(taskId: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return { taskId, directory: "packages/x", command: "true", dependencies: [], inputs: {}, ...overrides };
}

describe("the walk is turbo's, indexed and followed", () => {
  test("a plan is indexed by task id", () => {
    const graph = taskGraph({ tasks: [planned("@x/a#build"), planned("@x/b#build")] });
    expect([...graph.keys()].sort()).toEqual(["@x/a#build", "@x/b#build"]);
    expect(graph.get("@x/a#build")?.command).toBe("true");
  });

  // Two entries for one id would mean one of them is invisible, and which one is invisible would depend
  // on iteration order. Silence there is the defect this whole file exists to end.
  test("a plan that names one task twice is refused, not quietly collapsed", () => {
    expect(() => taskGraph({ tasks: [planned("@x/a#build"), planned("@x/a#build")] })).toThrow(
      "turbo planned @x/a#build twice",
    );
  });

  test("the closure holds the root and everything reachable from it", () => {
    const graph = taskGraph({
      tasks: [
        planned("@x/app#test", { dependencies: ["@x/mid#build"] }),
        planned("@x/mid#build", { dependencies: ["@x/leaf#build"] }),
        planned("@x/leaf#build"),
      ],
    });
    expect([...closure(graph, "@x/app#test")].sort()).toEqual(["@x/app#test", "@x/leaf#build", "@x/mid#build"]);
  });

  // Two paths to one task is the normal shape of this graph — `@pithy-sh/core#build` is reached from
  // nine places — and a walk that visits it nine times still has to answer once.
  test("a task reached twice is in the closure once", () => {
    const graph = taskGraph({
      tasks: [
        planned("@x/app#test", { dependencies: ["@x/left#build", "@x/right#build"] }),
        planned("@x/left#build", { dependencies: ["@x/leaf#build"] }),
        planned("@x/right#build", { dependencies: ["@x/leaf#build"] }),
        planned("@x/leaf#build"),
      ],
    });
    expect([...closure(graph, "@x/app#test")]).toHaveLength(4);
  });

  // Turbo refuses a cyclic task graph, so this is not a plan it emits. It is what the walk does when it
  // is handed one anyway, and the answer has to be "terminate" rather than "hang the suite".
  test("a cycle terminates", () => {
    const graph = taskGraph({
      tasks: [
        planned("@x/a#build", { dependencies: ["@x/b#build"] }),
        planned("@x/b#build", { dependencies: ["@x/a#build"] }),
      ],
    });
    expect([...closure(graph, "@x/a#build")].sort()).toEqual(["@x/a#build", "@x/b#build"]);
  });

  test("a root turbo did not plan is named", () => {
    const graph = taskGraph({ tasks: [planned("@x/a#build")] });
    expect(() => closure(graph, "@x/b#test")).toThrow("turbo planned no @x/b#test");
  });

  // The one failure a `Map` lookup makes easy to swallow. A dependency on a task the plan does not carry
  // means the plan is not the whole graph, and continuing past it is how a walk silently under-reports.
  test("an edge to a task the plan does not carry names both ends", () => {
    const graph = taskGraph({ tasks: [planned("@x/a#build", { dependencies: ["@x/gone#build"] })] });
    expect(() => closure(graph, "@x/a#build")).toThrow("@x/a#build depends on @x/gone#build, which turbo did not plan");
  });

  // A scoped name carries a `/` and an `@`, and a task name carries a `:`. The hash is the only
  // separator, and both halves keep everything else.
  test("a scoped package name and a colon in the task name both survive the split", () => {
    expect(packageOf("@pithy-sh/vite#build")).toBe("@pithy-sh/vite");
    expect(packageOf("@pithy-sh/cli#test:node")).toBe("@pithy-sh/cli");
  });

  test("an id with no task half is refused", () => {
    expect(() => packageOf("@pithy-sh/vite")).toThrow("@pithy-sh/vite is not a <package>#<task> id");
    expect(() => packageOf("#build")).toThrow("#build is not a <package>#<task> id");
  });

  test("each task in the set reports the directory it runs in, by package", () => {
    const graph = taskGraph({
      tasks: [
        planned("@x/a#build", { directory: "packages/a" }),
        planned("@x/a#test", { directory: "packages/a" }),
        planned("@x/fixture#test", { directory: "tooling/fixture" }),
      ],
    });
    expect([...directoriesOf(graph, ["@x/a#build", "@x/a#test", "@x/fixture#test"])]).toEqual([
      ["@x/a", "packages/a"],
      ["@x/fixture", "tooling/fixture"],
    ]);
  });

  // Turbo spells an input relative to the directory the task runs in, so a sibling package's file
  // arrives already written as a climb. Resolving it against the task's own directory is what makes two
  // tasks' input lists comparable at all — and it is the step a reader of this file must not have to
  // reproduce.
  test("an input is resolved against its own task's directory, not the root", () => {
    const graph = taskGraph({
      tasks: [
        planned("@x/beta#build", {
          directory: "tooling/beta",
          inputs: { "src/one.ts": "h1", "../gamma/src/two.ts": "h2" },
        }),
        planned("@x/gamma#build", { directory: "tooling/gamma", inputs: { "src/two.ts": "h2" } }),
      ],
    });
    expect([...inputsOf(graph, ["@x/beta#build", "@x/gamma#build"], "/repo")].sort()).toEqual([
      "tooling/beta/src/one.ts",
      "tooling/gamma/src/two.ts",
    ]);
  });

  test("an input list is asked of a task turbo planned", () => {
    const graph = taskGraph({ tasks: [planned("@x/a#build")] });
    expect(() => inputsOf(graph, ["@x/b#build"], "/repo")).toThrow("turbo planned no @x/b#build");
  });

  // `@pithy-sh/tsconfig` defines no `build` script, and turbo plans it anyway with this for its command.
  // It still carries inputs and it still moves the hash of everything downstream of it — measured on
  // 2.10.10 by appending one newline to `tooling/tsconfig/base.json`, which moved
  // `@pithy-sh/vite-adopter#test` from `d2e69bc7fa9d4854` to `ed40cf214a144314`. So the walk keeps it,
  // and the constant exists to say that the keeping is deliberate.
  test("the marker for a task a package does not define is what turbo writes", () => {
    expect(NO_SCRIPT).toBe("<NONEXISTENT>");
  });
});

/**
 * A whole turbo workspace, four packages deep, built in `os.tmpdir()` and planned by this repository's
 * own turbo.
 *
 * `@fx/fixture` → `@fx/c` → `@fx/b` → `@fx/a`, and the middle edge — `@fx/c` on `@fx/b` — is declared in
 * whichever manifest field the test names. Everything else is held still, so the only thing the four
 * runs differ by is the field.
 */
function workspace(field: string): string {
  const root = mkdtempSync(join(tmpdir(), "pithy-turbo-graph-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fx-root", private: true, packageManager: "bun@1.2.0", workspaces: ["*/*"] }),
  );
  writeFileSync(
    join(root, "turbo.jsonc"),
    JSON.stringify({ tasks: { build: { dependsOn: ["^build"] }, test: { dependsOn: ["^build", "build"] } } }),
  );
  const pkg = (directory: string, name: string, edges: Record<string, unknown>): void => {
    mkdirSync(join(root, directory, "src"), { recursive: true });
    writeFileSync(
      join(root, directory, "package.json"),
      JSON.stringify({ name, version: "0.0.0", scripts: { build: "true", test: "true" }, ...edges }),
    );
    writeFileSync(join(root, directory, "src", "index.ts"), "export const one = 1;\n");
  };
  pkg("packages/a", "@fx/a", {});
  pkg("packages/b", "@fx/b", { dependencies: { "@fx/a": "workspace:*" } });
  pkg("packages/c", "@fx/c", { [field]: { "@fx/b": "workspace:*" } });
  pkg("tooling/fixture", "@fx/fixture", { devDependencies: { "@fx/c": "workspace:*" } });
  // Turbo reads the workspace out of the package manager's view of it, so the lockfile has to exist and
  // has to be the one bun writes. Every edge is a workspace link, so nothing here reaches the network.
  execFileSync("bun", ["install"], { cwd: root, stdio: "ignore" });
  return root;
}

/** Every build turbo plans ahead of `@fx/fixture#test`, derived exactly as `turboInputs.test.ts` does. */
function upstream(root: string): string[] {
  const stdout = execFileSync(TURBO, ["run", "test", "--filter=@fx/fixture", "--dry=json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const graph = taskGraph(JSON.parse(stdout) as TurboPlan);
  return [...closure(graph, "@fx/fixture#test")].filter((id) => id.endsWith("#build")).sort();
}

/** `@fx/fixture#test`'s hash, which is the number turbo decides a cache hit with. */
function fixtureHash(root: string): string {
  const stdout = execFileSync(TURBO, ["run", "test", "--filter=@fx/fixture", "--dry=json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const plan = JSON.parse(stdout) as { tasks: { taskId: string; hash: string }[] };
  const task = plan.tasks.find((entry) => entry.taskId === "@fx/fixture#test");
  if (task === undefined) throw new Error("turbo planned no @fx/fixture#test");
  return task.hash;
}

/**
 * The walk this file replaced: a package's manifest, `dependencies` and `peerDependencies`, followed by
 * hand. Kept as the foil rather than deleted, because "a hand-rolled model drifts" is a claim and the
 * assertions below are a measurement.
 */
function manifestWalk(root: string, start: string): string[] {
  const dirs = new Map([
    ["@fx/a", join(root, "packages", "a")],
    ["@fx/b", join(root, "packages", "b")],
    ["@fx/c", join(root, "packages", "c")],
    ["@fx/fixture", join(root, "tooling", "fixture")],
  ]);
  const reached = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    const directory = dirs.get(name);
    if (directory === undefined) continue;
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const edge of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) {
      if (dirs.has(edge)) pending.push(edge);
    }
  }
  reached.delete(start);
  return [...reached].sort();
}

describe("what a manifest field costs, measured against turbo", () => {
  const roots: string[] = [];
  const built = (field: string): string => {
    const root = workspace(field);
    roots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  // **The test the issue asked for.** An edge moving between the fields turbo follows must change
  // nothing, because turbo's answer does not change — and a walk derived from turbo cannot notice a
  // move it is not reading. The old walk noticed, which is how #542 turned a no-op into a red build.
  test("an edge moving between the fields turbo follows changes nothing", () => {
    const byDependencies = upstream(built("dependencies"));
    const byDevDependencies = upstream(built("devDependencies"));
    const byOptionalDependencies = upstream(built("optionalDependencies"));

    // The vacuity floor: an empty walk agrees with an empty walk. `@fx/a` is three edges away, so
    // reaching it is the whole graph reached.
    expect(byDependencies).toEqual(["@fx/a#build", "@fx/b#build", "@fx/c#build", "@fx/fixture#build"]);

    expect(byDevDependencies).toEqual(byDependencies);
    expect(byOptionalDependencies).toEqual(byDependencies);
  });

  // **And the field that is not one of them.** Measured on turbo 2.10.10: `^build` does not follow a
  // `peerDependency`, even onto a workspace package the lockfile links. #542 assumed the opposite — that
  // the caching "was never affected" because a peer edge is part of the workspace graph — and it held
  // only because `@pithy-sh/vite` declares `@pithy-sh/core` in `devDependencies` as well.
  test("turbo does not follow a peerDependency, so a peer-only edge is not built ahead", () => {
    expect(upstream(built("peerDependencies"))).toEqual(["@fx/c#build", "@fx/fixture#build"]);
  });

  // The drift, in both directions, from one fixture. Narrow reddens and is survivable; wide goes green
  // over a cache turbo never covered. The manifest walk does both, depending only on which field
  // somebody typed.
  test("the manifest walk this replaced drifts narrow one way and wide the other", () => {
    expect(manifestWalk(built("devDependencies"), "@fx/c")).toEqual([]);
    expect(manifestWalk(built("peerDependencies"), "@fx/c")).toEqual(["@fx/a", "@fx/b"]);
  });

  // **Why the closure is the denominator next door, and not the task's own `inputs`.** A task's hash
  // folds in the hash of every task it depends on, so a file that no glob of `@fx/fixture#test` names is
  // still in its cache key as long as the edge is there. `turboInputs.test.ts` measures coverage over
  // the closure for exactly this reason; without this assertion that choice is a guess.
  test("a change three edges upstream moves the fixture task's hash", () => {
    const root = built("dependencies");
    const before = fixtureHash(root);
    writeFileSync(join(root, "packages", "a", "src", "index.ts"), "export const one = 2;\n");
    expect(fixtureHash(root)).not.toBe(before);
  });

  // The same, with the edge declared where turbo does not look. The hash stands still, which is the
  // stale cache the whole file is about — and it is the reason the kit's peer edges are also declared
  // somewhere turbo reads.
  test("the same change does not move it when the edge is peer-only", () => {
    const root = built("peerDependencies");
    const before = fixtureHash(root);
    writeFileSync(join(root, "packages", "a", "src", "index.ts"), "export const one = 2;\n");
    expect(fixtureHash(root)).toBe(before);
  });
});
