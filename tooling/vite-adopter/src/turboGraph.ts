// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

/**
 * Turbo's task graph, read out of turbo rather than rebuilt from the manifests it was built from.
 *
 * `turbo run <task> --filter=<package> --dry=json` reports every task the run would plan: the upstream
 * task ids each one depends on, the directory it runs in, and the files it hashes. That is the whole
 * dependency walk, already resolved, already reflecting whatever turbo currently does with `dependsOn`,
 * workspace links and manifest fields. Nothing here models any of it.
 *
 * **The alternative was tried and it drifted.** `turboInputs.test.ts` used to reconstruct the walk from
 * each package's `dependencies`; #542 moved the kit's shared packages to `peerDependencies` and the walk
 * stopped following `@pithy-sh/vite → @pithy-sh/core`. The fix at the time — read `peerDependencies` too
 * — turns out to be wrong in the other direction: measured on turbo 2.10.10 in `turboGraph.test.ts`,
 * `^build` follows `dependencies`, `devDependencies` and `optionalDependencies`, and **does not follow
 * `peerDependencies`**. A model that is narrower than the graph reddens; one that is wider goes green
 * over files turbo never hashed. Both are one field away from each other, which is the argument for
 * having no model.
 *
 * Everything below is a pure function over one plan, so the derivation is testable without a workspace.
 * {@link planOf} is the only part that runs turbo.
 */

const run = promisify(execFile);

/** One task, as `turbo run … --dry=json` plans it. Only the fields this derivation reads. */
export type PlannedTask = {
  /** `<package>#<task>`, e.g. `@pithy-sh/vite#build`. */
  taskId: string;
  /** The package's directory, relative to the repository root. Every input below is relative to it. */
  directory: string;
  /** The script turbo would run, or {@link NO_SCRIPT} when the package defines none. */
  command: string;
  /** The task ids this one depends on. One hop; {@link closure} does the rest. */
  dependencies: string[];
  /** The files turbo hashes for this task, keyed by path relative to {@link directory}. */
  inputs: Record<string, string>;
};

/** One `--dry=json` run. */
export type TurboPlan = { tasks: PlannedTask[] };

/**
 * What turbo writes for the command of a task a package does not define.
 *
 * Such a task is still planned, still carries inputs, and still moves the hash of everything downstream
 * of it — measured on 2.10.10 by appending one newline to `tooling/tsconfig/base.json`, which moved
 * `@pithy-sh/vite-adopter#test` from `d2e69bc7fa9d4854` to `ed40cf214a144314`. So {@link closure} keeps
 * it and this constant exists to say the keeping is deliberate.
 */
export const NO_SCRIPT = "<NONEXISTENT>";

/** A plan indexed by task id. */
export function taskGraph(plan: TurboPlan): Map<string, PlannedTask> {
  const graph = new Map<string, PlannedTask>();
  for (const task of plan.tasks) {
    // Two entries for one id would leave one of them invisible, and which one would depend on iteration
    // order. Silence is the failure this file exists to end.
    if (graph.has(task.taskId)) throw new Error(`turbo planned ${task.taskId} twice`);
    graph.set(task.taskId, task);
  }
  return graph;
}

/**
 * `taskId` and every task reachable from it through `dependencies`.
 *
 * A dependency the plan does not carry is thrown on rather than skipped: it would mean the plan is not
 * the whole graph, and a walk that continues past it under-reports without saying so.
 */
export function closure(graph: ReadonlyMap<string, PlannedTask>, taskId: string): Set<string> {
  if (!graph.has(taskId)) throw new Error(`turbo planned no ${taskId}`);
  const reached = new Set<string>();
  const pending: { id: string; from: string | null }[] = [{ id: taskId, from: null }];
  while (pending.length > 0) {
    const { id, from } = pending.pop() as { id: string; from: string | null };
    if (reached.has(id)) continue;
    const task = graph.get(id);
    if (task === undefined) throw new Error(`${from} depends on ${id}, which turbo did not plan`);
    reached.add(id);
    for (const next of task.dependencies) pending.push({ id: next, from: id });
  }
  return reached;
}

/** The package half of a task id. Split at the last hash, because a scoped name holds none and a task may. */
export function packageOf(taskId: string): string {
  const hash = taskId.lastIndexOf("#");
  if (hash <= 0) throw new Error(`${taskId} is not a <package>#<task> id`);
  return taskId.slice(0, hash);
}

/** The directory each of `taskIds` runs in, by package name. */
export function directoriesOf(graph: ReadonlyMap<string, PlannedTask>, taskIds: Iterable<string>): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const id of taskIds) {
    const task = graph.get(id);
    if (task === undefined) throw new Error(`turbo planned no ${id}`);
    dirs.set(packageOf(id), task.directory);
  }
  return dirs;
}

/**
 * Every file hashed by any of `taskIds`, relative to `root` and in POSIX form.
 *
 * Turbo spells an input relative to the directory its task runs in, so a sibling package's file arrives
 * already written as a climb. Resolving each key against its own task's directory is what makes two
 * tasks' lists comparable, and it is the step no caller should have to reproduce.
 */
export function inputsOf(
  graph: ReadonlyMap<string, PlannedTask>,
  taskIds: Iterable<string>,
  root: string,
): Set<string> {
  const files = new Set<string>();
  for (const id of taskIds) {
    const task = graph.get(id);
    if (task === undefined) throw new Error(`turbo planned no ${id}`);
    const directory = resolve(root, task.directory);
    for (const key of Object.keys(task.inputs)) {
      files.add(relative(root, resolve(directory, key)).split(sep).join("/"));
    }
  }
  return files;
}

/**
 * One `--dry=json` run, indexed. The only thing here that shells out.
 *
 * `filter` is optional because the two questions are different: filtered asks what one package's run
 * would plan, unfiltered asks the workspace what it holds. Turbo has no selector meaning "everything" —
 * `--filter=...` is rejected as a selector with no pattern — so the flag is omitted rather than faked.
 */
export async function planOf(
  turbo: string,
  root: string,
  task: string,
  filter?: string,
): Promise<Map<string, PlannedTask>> {
  const args = ["run", task, "--dry=json"];
  if (filter !== undefined) args.splice(2, 0, `--filter=${filter}`);
  const { stdout } = await run(turbo, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return taskGraph(JSON.parse(stdout) as TurboPlan);
}
