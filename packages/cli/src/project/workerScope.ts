// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { allCapabilities, loadWorkerConfig, type WorkerConfig } from "./config";
import { discoverWorkers as discoverWorkersDefault, type WorkerTarget } from "./workers";

/**
 * Resolving *which Worker* a command acts on — the one seam every per-Worker command shares.
 *
 * Since every Worker lives in `apps/<name>/` with its own `pithy.config.ts` and `wrangler.jsonc`, a command
 * either targets **one** Worker (`add`, `remove` — they write that Worker's wiring) or **fans out** over the
 * whole set (`migrate`, `seed`, `upgrade`, `doctor`, `env`). Both paths resolve through here so the ambiguity
 * rules and the error copy stay identical across the CLI.
 */

/** A Worker plus its loaded config — what a per-Worker command actually needs to do its work. */
export interface ResolvedWorker {
  /** The Worker's name (its `wrangler.jsonc` name, else its `apps/<dir>` basename). */
  name: string;
  /** The Worker's directory — where its `wrangler.jsonc` and `pithy.config.ts` live. */
  dir: string;
  /** The Worker's own `pithy.config.ts`. */
  config: WorkerConfig;
  /** That config's capabilities in composition order — libraries first, its app last. */
  capabilities: Capability[];
  /** The discovered target, carrying its dev-manifest block. */
  target: WorkerTarget;
}

/** Shared options for both resolvers: the project root, plus seams so tests need no real filesystem. */
export interface ResolveOptions {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** Discovery seam (default: `discoverWorkers`). */
  discoverWorkers?: (projectDir: string) => Promise<WorkerTarget[]>;
  /** Worker-config loader seam (default: `loadWorkerConfig`). */
  loadConfig?: (workerDir: string) => Promise<WorkerConfig>;
}

/**
 * The actionable error when nothing resolved, distinguishing the two very different causes: standing outside
 * a Pithy project entirely (no root `pithy.config.ts` — you want `pithy init`) versus standing in one that has
 * no Workers yet (you want `pithy worker add`). Telling someone to add a worker when they are simply in the
 * wrong directory sends them the wrong way.
 */
async function noWorkers(projectDir: string): Promise<never> {
  try {
    await access(join(projectDir, "pithy.config.ts"));
  } catch {
    throw new NotFoundError({
      message: "No pithy.config.ts here.",
      action: "Run from a Pithy project. pithy init creates one.",
    });
  }
  throw new NotFoundError({
    message: "No workers here.",
    action: "Every worker lives in apps/<name>. Run pithy worker add <name> to create one.",
  });
}

/** Load a discovered target's config, attaching its capabilities. */
async function resolve(target: WorkerTarget, load: (dir: string) => Promise<WorkerConfig>): Promise<ResolvedWorker> {
  const config = await load(target.dir);
  return { name: target.name, dir: target.dir, config, capabilities: allCapabilities(config), target };
}

/**
 * Every Worker in the project, each with its config loaded — the fan-out set for `migrate`, `seed`,
 * `upgrade`, `doctor`, and `env`. Pass `worker` to narrow to one. Workers are returned in discovery order
 * (alphabetical), so output ordering is stable run to run.
 *
 * Only Workers that carry a `pithy.config.ts` are returned: a non-Worker dev process (a Vite frontend joining
 * the dev set via `pithy.worker.jsonc` alone) has no capabilities to migrate, seed, or reconcile.
 */
export async function resolveWorkers(options: ResolveOptions & { worker?: string }): Promise<ResolvedWorker[]> {
  const discover = options.discoverWorkers ?? discoverWorkersDefault;
  const load = options.loadConfig ?? loadWorkerConfig;
  const targets = await discover(options.projectDir);
  if (targets.length === 0) await noWorkers(options.projectDir);

  if (options.worker !== undefined) {
    return [await resolve(pick(targets, options.worker), load)];
  }

  const resolved: ResolvedWorker[] = [];
  for (const target of targets) {
    // A dev-only process (**no** pithy.config.ts) contributes nothing to composed work — skip it, don't fail.
    // A config that exists but cannot be loaded is a different matter entirely: swallowing it would report
    // "No workers here" for a project that plainly has workers, hiding the real cause (usually uninstalled
    // dependencies or a syntax error). Only the file-absent case is skippable; everything else surfaces.
    let config: WorkerConfig;
    try {
      config = await load(target.dir);
    } catch (error) {
      if (error instanceof PithyError && error.payload.code === "core/not_found") continue;
      throw error;
    }
    resolved.push({ name: target.name, dir: target.dir, config, capabilities: allCapabilities(config), target });
  }
  if (resolved.length === 0) await noWorkers(options.projectDir);
  return resolved;
}

/** Find a Worker by the name `pithy worker list` shows, or by its `apps/<dir>` basename. */
function pick(targets: WorkerTarget[], name: string): WorkerTarget {
  const found = targets.find((target) => target.name === name || target.dir.endsWith(`/${name}`));
  if (!found) {
    throw new NotFoundError({
      message: `No worker named "${name}".`,
      action: `Run pithy worker list to see this project's workers. Known: ${targets.map((t) => t.name).join(", ")}.`,
    });
  }
  return found;
}

/**
 * Fold a later instance of an already-seen capability into the kept one: same entry, plus any binding the
 * later instance declares that the kept one does not. Returns the kept instance untouched when it declares
 * everything (the common case — two Workers composing the same capability the same way), so nothing is
 * copied unless a binding would otherwise be dropped. Bindings are matched by **name**, because one binding
 * name is exactly one provisioned resource.
 */
function mergeBindings(kept: Capability, later: Capability): Capability {
  const declared = new Set(kept.requiredBindings.map((binding) => binding.name));
  const extra = later.requiredBindings.filter((binding) => !declared.has(binding.name));
  return extra.length === 0 ? kept : { ...kept, requiredBindings: [...kept.requiredBindings, ...extra] };
}

/**
 * Every capability composed anywhere in the project, one entry per name, in worker-discovery order.
 *
 * Most commands fan out per Worker — that is the point of the layout. A few genuinely need the project's
 * whole capability surface as one list: `pithy feature` provisions **one** resource per binding name for the
 * whole feature (two Workers that both declare `DB` deliberately share a database), and the local
 * migrate/seed it runs must cover every table any Worker owns.
 *
 * One entry per capability **name**, because a capability composed by two Workers ships one migration
 * namespace and one set of tables — running it twice would double-apply the same registry. But two Workers
 * may compose the same capability with **different config**, and config changes what it binds
 * (`media({ recordStore: "kv" })` adds a KV namespace; `audit({ database })` renames the D1 binding).
 * Keeping only the first instance would drop the second's bindings from the union `pithy provision`
 * creates resources from, leaving that Worker deployed with a binding nothing backs. So the first instance
 * wins and every later instance's *additional* bindings are folded into it: one namespace, no lost binding.
 */
export function projectCapabilities(workers: readonly ResolvedWorker[]): Capability[] {
  const byName = new Map<string, Capability>();
  for (const worker of workers) {
    for (const capability of worker.capabilities) {
      const kept = byName.get(capability.name);
      byName.set(capability.name, kept ? mergeBindings(kept, capability) : capability);
    }
  }
  return [...byName.values()];
}

/** Options for {@link resolveSingleWorker}. */
export interface ResolveSingleOptions extends ResolveOptions {
  /** The `--worker` value, when the caller passed one. */
  worker?: string;
  /**
   * Prompt for the Worker when several exist and none was named. Supplied only by an interactive command
   * (a TTY, not `--json`); omitted, ambiguity is an actionable error instead.
   */
  prompt?: (choices: ResolvedWorker[]) => Promise<string>;
}

/**
 * The single Worker a wiring command acts on — `pithy add`/`remove`, which write one Worker's
 * `pithy.config.ts` and `wrangler.jsonc`.
 *
 * `--worker` names it outright. With none named: a project holding exactly one Worker uses it (the common
 * case — no ceremony for a single-Worker project); a project holding several **never guesses**, because
 * wiring a capability into the wrong Worker silently puts bindings and Durable Object class migrations on the
 * wrong script. It prompts when a human is attached, and fails with an actionable error otherwise, so an
 * agent driving `--json` gets told exactly what to pass rather than a surprise.
 */
export async function resolveSingleWorker(options: ResolveSingleOptions): Promise<ResolvedWorker> {
  const workers = await resolveWorkers({
    projectDir: options.projectDir,
    ...(options.discoverWorkers ? { discoverWorkers: options.discoverWorkers } : {}),
    ...(options.loadConfig ? { loadConfig: options.loadConfig } : {}),
  });

  if (options.worker !== undefined) {
    const found = workers.find(
      (candidate) => candidate.name === options.worker || candidate.dir.endsWith(`/${options.worker}`),
    );
    if (!found) {
      throw new NotFoundError({
        message: `No worker named "${options.worker}".`,
        action: `Run pithy worker list to see this project's workers. Known: ${workers.map((w) => w.name).join(", ")}.`,
      });
    }
    return found;
  }

  const only = workers[0];
  if (workers.length === 1 && only) return only;

  if (options.prompt) {
    const chosen = await options.prompt(workers);
    const found = workers.find((candidate) => candidate.name === chosen);
    if (found) return found;
  }

  throw new ValidationError({
    message: "This project has several workers, so which one to wire is ambiguous.",
    action: `Pass --worker <name>. Known: ${workers.map((w) => w.name).join(", ")}.`,
  });
}
