// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { messageOf, NotFoundError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { composeCapabilities } from "../capabilities/compose";
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

/** A discovered Worker left out of a resolution, and why. */
export interface SkippedWorker {
  /** The Worker's name, as `pithy worker list` shows it. */
  name: string;
  /** The Worker's directory. */
  dir: string;
  /** Why its config could not be read. Reaches a terminal, so never `detail`. */
  reason: string;
}

/** Both halves of one resolution: the Workers that resolved, and the ones that could not be asked. */
export interface WorkerResolution {
  /** Every Worker whose `pithy.config.ts` loaded, in discovery order. */
  workers: ResolvedWorker[];
  /**
   * Every Worker the set is *missing* — a directory with a `wrangler.jsonc` whose `pithy.config.ts` is
   * absent. Empty on an ordinary run, and empty for a dev-only process, which never had one.
   */
  skipped: SkippedWorker[];
}

/**
 * Every Worker in the project **and every one that had to be left out** — the two answers that must not
 * arrive as one (#455). {@link resolveWorkers} is this with the second half dropped, which is the right
 * call for a fan-out that acts per Worker and the wrong one for anything reasoning about the project as a
 * whole.
 *
 * A `pithy.config.ts` that **throws** still throws from here, unchanged: swallowing it reports
 * "No workers here" for a project that plainly has workers, hiding the real cause (usually uninstalled
 * dependencies or a syntax error). What changes is the *absent* file. A dev-only process — a Vite frontend
 * joining the dev set through `pithy.worker.jsonc` alone — has no config and never had one, so skipping it
 * is the ordinary state. A directory with a `wrangler.jsonc` is a Worker, so a missing config there means
 * the resolved set is **incomplete**, not merely smaller: `#454`'s guard closes "a config throws" and this
 * is the case it does not cover. `feature destroy`'s reconcile backstop scans the union's bindings, so a
 * Worker silently dropped leaks every resource it declared while the run exits 0.
 *
 * `hasWrangler` is what tells the two apart, and it is read strictly (`=== true`): real discovery always
 * sets it, and the many test doubles that carry only `name`/`dir` must not start reporting themselves as
 * gaps. See {@link WorkerTarget}.
 */
export async function resolveWorkersReporting(
  options: ResolveOptions & { worker?: string },
): Promise<WorkerResolution> {
  const discover = options.discoverWorkers ?? discoverWorkersDefault;
  const load = options.loadConfig ?? loadWorkerConfig;
  const targets = await discover(options.projectDir);
  if (targets.length === 0) await noWorkers(options.projectDir);

  if (options.worker !== undefined) {
    // A named Worker is the one the caller asked for: its config is loaded, and its failure is theirs to
    // see. Narrowing happens *before* the load, so a sibling's broken config costs nothing.
    return { workers: [await resolve(pick(targets, options.worker), load)], skipped: [] };
  }

  const workers: ResolvedWorker[] = [];
  const skipped: SkippedWorker[] = [];
  for (const target of targets) {
    let config: WorkerConfig;
    try {
      config = await load(target.dir);
    } catch (error) {
      if (!(error instanceof PithyError && error.payload.code === "core/not_found")) throw error;
      if (target.hasWrangler === true) skipped.push({ name: target.name, dir: target.dir, reason: messageOf(error) });
      continue;
    }
    workers.push({ name: target.name, dir: target.dir, config, capabilities: allCapabilities(config), target });
  }
  // Nothing resolved and nothing skipped is genuinely nothing, and {@link noWorkers} says which kind. An
  // empty set *with* something skipped is a different fact, and reporting it is this function's whole job
  // — the refusal belongs to {@link resolveWorkers}, whose callers have only an array to read it from.
  if (workers.length === 0 && skipped.length === 0) await noWorkers(options.projectDir);
  return { workers, skipped };
}

/**
 * The refusal when every discovered Worker is missing its `pithy.config.ts`. "No workers here" is false —
 * the project plainly has them — and it sent the reader to `pithy worker add` for Workers that exist.
 */
function everyWorkerUnreadable(skipped: readonly SkippedWorker[]): never {
  throw new NotFoundError({
    message: "Every worker here is missing its pithy.config.ts.",
    action: `Restore it, or run pithy worker add to rewrite one. Missing: ${skipped.map((s) => s.name).join(", ")}.`,
  });
}

/**
 * Every Worker in the project, each with its config loaded — the fan-out set for `migrate`, `seed`,
 * `upgrade`, `doctor`, and `env`. Pass `worker` to narrow to one. Workers are returned in discovery order
 * (alphabetical), so output ordering is stable run to run.
 *
 * Only Workers that carry a `pithy.config.ts` are returned: a non-Worker dev process (a Vite frontend joining
 * the dev set via `pithy.worker.jsonc` alone) has no capabilities to migrate, seed, or reconcile. A command
 * that acts on the project as a whole rather than per Worker wants {@link resolveWorkersReporting}, which
 * also names the Workers this one drops.
 */
export async function resolveWorkers(options: ResolveOptions & { worker?: string }): Promise<ResolvedWorker[]> {
  const { workers, skipped } = await resolveWorkersReporting(options);
  if (workers.length === 0) everyWorkerUnreadable(skipped);
  return workers;
}

/**
 * Why a set could not be determined — the third state, **carrying its own diagnosis**.
 *
 * A bare `null` was the first shape of this and it repeated `#454`'s own mistake one level down: every
 * refusal downstream had to invent a sentence, and each invented the same wrong one — *this project's
 * Worker configuration will not load* — for a config that is **absent**, pointing the reader at a file
 * that does not exist and never naming which Worker. {@link resolveWorkersReporting} knows both facts, so
 * the reason travels with the refusal instead of being recomputed badly by whoever catches it.
 */
export interface UnknownSet {
  /** One actionable sentence naming the Workers that could not be read. Reaches a terminal, never `detail`. */
  readonly unknown: string;
}

/** Every Worker in the project, or why that set cannot be known. */
export type WorkerSet = ResolvedWorker[] | UnknownSet;

/** Every capability composed anywhere in the project, or why that set cannot be known. */
export type CapabilitySet = readonly Capability[] | UnknownSet;

/**
 * Narrow either set: `true` when the answer is unknowable. An array — **including an empty one** — is a
 * real answer, and that is the whole distinction: a project with no Workers composes nothing, and one
 * whose config will not load composes something nobody here can name.
 */
export function isUnknown<T>(set: readonly T[] | UnknownSet): set is UnknownSet {
  return !Array.isArray(set);
}

/** The diagnosis for a set left incomplete by Workers whose `pithy.config.ts` is absent. */
function missingConfigs(skipped: readonly SkippedWorker[]): UnknownSet {
  const names = skipped.map((worker) => worker.name).join(", ");
  return { unknown: `No pithy.config.ts in ${names} — every worker under apps/ needs one.` };
}

/**
 * Every Worker resolved, or why the set is **unknowable from here** — the third state (#455).
 *
 * Unknowable is not "none". A project with no Workers at all answers `[]`, because nothing was ever named
 * and there is nothing to reason about. {@link UnknownSet} means a `pithy.config.ts` threw, or a Worker was
 * skipped and the set that came back is incomplete — and a caller deriving policy from it (which
 * credentials CI gets, whether this project audits, which resources teardown must delete) has to refuse
 * rather than infer absence. Folding the two together is what let `pithy deploy` ship unaudited and exit 0.
 *
 * **Deliberately no `worker`.** The distinction only means something across the project: narrowed to one
 * Worker, `core/not_found` stops being "this project has no Workers" and becomes "*this* Worker has no
 * config", which the catch below would answer `[]` — the exact conflation this function exists to undo.
 * A caller wanting one Worker wants {@link resolveWorkers}, whose failure is theirs to see.
 */
export async function resolveWorkerSet(options: ResolveOptions): Promise<WorkerSet> {
  try {
    const { workers, skipped } = await resolveWorkersReporting(options);
    // Incomplete is unknowable: a Worker nobody could read is a Worker whose capabilities are unaccounted
    // for, and every caller of this function derives policy from the set being whole.
    return skipped.length > 0 ? missingConfigs(skipped) : workers;
  } catch (error) {
    /*
      **A project with no Workers is `[]`, not unknowable.** `resolveWorkers` throws `core/not_found` for
      exactly that — an empty `apps/`, or one holding only dev-only processes with no `pithy.config.ts` —
      and nothing was ever named, so a reconcile pass has nothing to recompute and a manifest pass still
      runs. Swallowed into `null`, `feature destroy` refused with a diagnosis that was not true: *this
      project's Worker configuration will not load*, pointing at a file that does not exist, and a CI
      teardown failed on it (#454).

      `core/not_found` also covers "no `pithy.config.ts` here", which is not this — but a caller wanting the
      third state loads the *root* config first and throws its own error before reaching here. The
      every-Worker-unreadable case never arrives as a throw at all: {@link resolveWorkersReporting} reports
      it, and the branch above has already read it as `null`.
    */
    if (error instanceof PithyError && error.payload.code === "core/not_found") return [];
    return { unknown: messageOf(error) };
  }
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

/**
 * The same union, or why it is **unknowable from here** — the third state (#455, #454).
 *
 * Unknowable is not "none", and every caller has to tell the two apart. An empty array would let `feature
 * destroy` report a clean remote teardown having deleted nothing, `pithy deploy` ship unaudited from a
 * project that has audit composed, and `pithy token rotate` mint a replacement carrying only the base
 * permissions before deleting the fully-permissioned token it replaces. See {@link resolveWorkerSet} for
 * what separates `[]` from an {@link UnknownSet}.
 */
export async function projectCapabilitySet(
  projectDir: string,
  seams: Omit<ResolveOptions, "projectDir"> = {},
): Promise<CapabilitySet> {
  return capabilitySetOf(await resolveWorkerSet({ projectDir, ...seams }));
}

/**
 * {@link projectCapabilities} over a set that may be unknowable — the pure half of
 * {@link projectCapabilitySet}, for a caller that already resolved the Workers and would otherwise
 * resolve them a second time.
 */
export function capabilitySetOf(workers: WorkerSet): CapabilitySet {
  return isUnknown(workers) ? workers : projectCapabilities(workers);
}

/**
 * The same union, **assembled** — every capability's `compose` hook run over it, the way a Worker runs
 * them at startup.
 *
 * The pairing is deliberate. {@link projectCapabilities} is a pure fold and stays one, because most of
 * its callers want the binding surface and nothing else. A caller that goes on to *read* a value off a
 * capability — `hostCatalogs()`, `layersFor`, `composedMessages` — wants this one, because those are
 * the values a hook fills and they are placeholders until it has. See {@link composeCapabilities} for
 * what an uncomposed read produces, and why it is silent.
 */
export function composedProjectCapabilities(workers: readonly ResolvedWorker[]): Capability[] {
  return composeCapabilities(projectCapabilities(workers));
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
  const seams = {
    ...(options.discoverWorkers ? { discoverWorkers: options.discoverWorkers } : {}),
    ...(options.loadConfig ? { loadConfig: options.loadConfig } : {}),
  };

  // A named Worker narrows **before** the load (#455). Resolving the whole set first meant one unloadable
  // config disabled `pithy add` and `pithy remove` for every Worker in the project — including when editing
  // a healthy Worker was the way around the broken one. `resolveWorkers` already supports the narrowing,
  // and its own "No worker named" error builds the `Known:` list from discovery, which needs no load.
  if (options.worker !== undefined) {
    const [found] = await resolveWorkers({ projectDir: options.projectDir, worker: options.worker, ...seams });
    // Unreachable: the single-Worker path either resolves one or throws. Narrowed for the type, not the case.
    if (!found) throw new NotFoundError({ message: `No worker named "${options.worker}".` });
    return found;
  }

  // With none named, the *set* is the question — how many Workers there are decides between using the only
  // one, prompting, and refusing — so every config is loaded, and one that will not load is still fatal.
  // Guessing past it would wire bindings and Durable Object class migrations onto the wrong script.
  const workers = await resolveWorkers({ projectDir: options.projectDir, ...seams });

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
