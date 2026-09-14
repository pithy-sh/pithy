// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { kebab } from "@pithy-sh/core/src/naming/resource";
import { HOST_WORKERS, hostWorkerFor } from "../capabilities/hostRegistry";
import { loadProject } from "../project/config";
import { environmentWorkerName } from "../project/scaffold";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * Whether a Worker's three names still agree.
 *
 * **A Worker's name is not one string.** It is stamped in three places, and every one of them is read by
 * something different:
 *
 * - the directory, `apps/<name>/`, which tsconfig references and CI working-directories point at;
 * - the deployed script name in `wrangler.jsonc`, which is what Cloudflare serves it under;
 * - `vars.WORKER`, which is what separates two Workers' audit events when they share a database.
 *
 * `pithy worker rename` moves all three together. A rename done by hand — `git mv`, then the edits —
 * moves whichever the person remembered, and nothing until now noticed the rest. The failure is quiet and
 * it is the worst shape a failure can take: the Worker deploys under one name and stamps its events with
 * another, so the audit trail names a Worker that is not the one that acted.
 *
 * This is the counterpart to {@link checkProjectName}, one level down, and it is held to the same
 * evidence discipline: a name is only a fault when this repo's own files positively contradict each
 * other. An adopter who migrated an existing Worker in has a script name Pithy never composed, and that
 * is theirs.
 */
export type WorkerNameState =
  /** Every stamp this project declares agrees with the directory it sits in. */
  | "ok"
  /** A `wrangler.jsonc` would not parse, or the worker set would not enumerate. Never fails the exit. */
  | "could-not-check"
  /** A stamp contradicts the directory. Established from local files alone, and it fails the exit. */
  | "drifted";

/** One stamp that disagrees with the directory holding it. */
export interface WorkerNameMismatch {
  /** The `apps/<dir>` basename — the anchor, since tsconfig and CI point at the path, not at a config key. */
  worker: string;
  /** Which stamp disagrees: the deployed script name, or the `WORKER` var. */
  stamp: "name" | "vars.WORKER";
  /** The value the file declares. */
  declared: string;
  /** The value the directory implies. */
  expected: string;
  /**
   * The environment stanzas declaring it — `dev` for the top-level one. Empty for the script name, which
   * is one top-level key rather than a per-environment one.
   */
  envs: string[];
}

/**
 * A declared environment name that is **byte-identical to a capability's own host Worker** (#580).
 *
 * `<project>-<env>-<worker>` is the shape a Worker takes now, and `<project>-<env>-<capability>` is the
 * shape a capability's host Worker has always taken. When the worker is called `email` those are the same
 * string, and Cloudflare's script namespace is account-flat: `wrangler deploy --env staging` replaces the
 * capability's host with an app, the capability's Workflows stop running, and nothing says so.
 *
 * `assertWorkerName` refuses to *create* such a worker. This is the same rule asked of a project that
 * already exists — a hand-written stanza, or a directory renamed before the refusal shipped.
 */
export interface ReservedWorkerName {
  /** The `apps/<dir>` basename whose config declares it. */
  worker: string;
  /** The environment stanza declaring it. */
  env: string;
  /** The declared script name — the same string the capability's host deploys under. */
  name: string;
  /** The capability whose host Worker owns that name, from the host registry. */
  capability: string;
}

/**
 * A Worker whose environment stanzas name no script, so wrangler suffixes the top-level one (#580).
 *
 * **Reported, never a fault, and it never fails the exit.** A Worker's name is the adopter's, and the
 * kit's shape is a convention rather than a requirement: a rename means a new script, a route moved onto
 * it, and a window where the old name is still answering. That is a deploy-time change somebody makes
 * when it is cheap, not a thing a diagnostic should refuse to go green over.
 *
 * **And it is only ever written for a Worker the kit would let you create under that name.** The note
 * composes {@link environmentWorkerName}, which is byte-identical to a capability's host Worker when the
 * worker is called `email` — so for an `apps/email` this block recommended, as a friendly optional
 * suggestion, the exact string {@link ReservedWorkerName} fails the exit over, and an adopter who took
 * the advice created the collision the other half exists to find. A Worker there is no legal convention
 * name for gets no note: its suffixed name collides with nothing, and there is no advice to give.
 */
export interface WorkerNameConvention {
  /** The `apps/<dir>` basename. */
  worker: string;
  /** Each environment that declares no name: where it lands today, and where the convention would put it. */
  environments: { env: string; current: string; convention: string }[];
}

/** What `doctor` learned about this project's worker names. */
export interface WorkerNameCheck {
  state: WorkerNameState;
  mismatches: WorkerNameMismatch[];
  /** Declared names a capability's host Worker already owns. Non-empty is a fault — see {@link ReservedWorkerName}. */
  reserved: ReservedWorkerName[];
  /** Workers still on wrangler's suffix. A report line and nothing more — see {@link WorkerNameConvention}. */
  convention: WorkerNameConvention[];
}

/** The `wrangler.jsonc` keys this reads: the script name, and the `WORKER` var in every stanza. */
interface NamedWorkerConfig {
  name?: string;
  vars?: Record<string, string | undefined>;
  env?: Record<string, NamedWorkerConfig | undefined>;
}

/**
 * The reserved-name clashes one Worker's config declares, and the environments still on wrangler's suffix.
 *
 * Both answers come from the same walk of `env.<name>`, because they are the two halves of one question —
 * what does this Worker deploy as in each environment, and is that a name it may have. A stanza that
 * names nothing cannot clash, and a stanza that names something is not on the suffix, so no environment
 * ever appears in both.
 *
 * **The reserved set is read from the host registry, never restated.** A ninth capability shipping a host
 * Worker joins this check the day it is registered; a literal list here would go stale silently, and the
 * failure it would let through is the one this check exists to find.
 */
function environmentNameFindings(
  worker: string,
  config: NamedWorkerConfig,
  project: string | null,
): { reserved: ReservedWorkerName[]; convention: WorkerNameConvention | null } {
  const reserved: ReservedWorkerName[] = [];
  const suffixed: WorkerNameConvention["environments"] = [];
  // No project name is no basis for either answer: both compose `<project>-<env>-…`, and a check that
  // guessed the project would report a clash with a capability host this project does not have.
  if (project === null) return { reserved: [], convention: null };

  // The top-level name a nameless stanza is suffixed from, or `undefined` when there is no note to write.
  // **Two conditions, and neither of them is the reserved half's** — that half reads a name the stanza
  // declares and compares it to `<project>-<env>-<capability>`, so it needs the project and nothing else.
  // A config with no top-level `name` is legal — wrangler takes the name from each stanza, which is the
  // shape the dashboard's prod stanza has — and the whole check used to return empty on it, so the one
  // finding that stops an adopter silently replacing a capability's Worker never ran. And a worker the
  // kit refuses to create under its own directory name has no convention to be put on: the name the
  // convention composes for it is the reserved one.
  const suffixFrom = hostWorkerFor(worker) === undefined ? config.name : undefined;

  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    const declared = stanza?.name;
    if (declared === undefined) {
      if (suffixFrom !== undefined)
        suffixed.push({
          env,
          current: `${suffixFrom}-${env}`,
          convention: environmentWorkerName(project, env, worker),
        });
      continue;
    }
    const capability = HOST_WORKERS.map((spec) => spec.capability).find(
      (name) => declared === environmentWorkerName(project, env, name),
    );
    if (capability !== undefined) reserved.push({ worker, env, name: declared, capability });
  }

  return { reserved, convention: suffixed.length > 0 ? { worker, environments: suffixed } : null };
}

/** Every environment's stanza: the top-level one (the dev environment) plus each `env.<name>`. */
function envStanzas(config: NamedWorkerConfig): { env: string; stanza: NamedWorkerConfig }[] {
  const list = [{ env: "dev", stanza: config }];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}

/**
 * The script-name mismatch for one Worker, or `null` when there is nothing to say.
 *
 * **Shape is the filter, exactly as it is for the project name.** `<project>-<worker>` is what
 * `scaffoldWorker` writes, so a declared name leading with this project's own segment was composed by
 * Pithy's rule and its tail is a worker segment — a tail that is not the directory is this repo
 * contradicting itself. A name that does not lead with the project (`my-service`, brought in from a
 * Worker that predates the project) was never composed from anything, so nothing local establishes what
 * it ought to be, and a check that renamed it would be inventing a fault on the adoption path.
 */
function scriptNameMismatch(worker: string, declared: string | undefined, project: string | null): boolean {
  if (declared === undefined || project === null) return false;
  return declared.startsWith(`${project}-`) && declared !== `${project}-${worker}`;
}

/** Group the per-environment `WORKER` disagreements by the value they declare — one line per wrong value. */
function workerVarMismatches(worker: string, config: NamedWorkerConfig): WorkerNameMismatch[] {
  const byValue = new Map<string, string[]>();
  for (const { env, stanza } of envStanzas(config)) {
    const declared = stanza.vars?.WORKER;
    // A stanza that declares no `WORKER` declares nothing to contradict. Adding one is `pithy worker`'s
    // job, not a diagnostic's, and reporting its absence would fail every Worker written before the var.
    if (declared === undefined || declared === worker) continue;
    byValue.set(declared, [...(byValue.get(declared) ?? []), env]);
  }
  return [...byValue].map(([declared, envs]) => ({
    worker,
    stamp: "vars.WORKER" as const,
    declared,
    expected: worker,
    envs,
  }));
}

/** The configured project name, or `null` when the root config would not read or carries none. */
async function configuredProject(projectDir: string): Promise<string | null> {
  try {
    const config = await loadProject(projectDir);
    // Kebabed through core's own helper, because that is the form `scaffoldWorker` stamped into the
    // script name. An illegal name is not refused here: `checkProjectName` is the check that owns that
    // verdict, and two blocks reporting one fault is how a report starts contradicting itself.
    return config.name ? kebab(config.name) : null;
  } catch {
    return null;
  }
}

/**
 * Check every Worker under `apps/` for the three-way disagreement a hand-rename leaves.
 *
 * Never throws. A diagnostic has to work in the broken project it exists to diagnose, so an unreadable
 * `wrangler.jsonc` becomes `could-not-check` rather than an exception — and only when nothing else was
 * found. A mismatch this read is a fault whether or not the next file parsed; degrading a positive
 * finding into "I could not check" would hide the fault behind the noise.
 */
export async function checkWorkerNames(projectDir: string): Promise<WorkerNameCheck> {
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", mismatches: [], reserved: [], convention: [] };
  }

  const project = await configuredProject(projectDir);
  const mismatches: WorkerNameMismatch[] = [];
  const reserved: ReservedWorkerName[] = [];
  const convention: WorkerNameConvention[] = [];
  let unreadable = false;
  for (const target of workers) {
    if (!target.hasWrangler) continue; // a non-Worker process in the dev set has no script name at all
    let config: NamedWorkerConfig;
    try {
      config = (await readWranglerConfig(target.dir)) as NamedWorkerConfig;
    } catch {
      unreadable = true;
      continue;
    }
    const worker = basename(target.dir);
    if (scriptNameMismatch(worker, config.name, project) && config.name !== undefined) {
      mismatches.push({
        worker,
        stamp: "name",
        declared: config.name,
        expected: `${project}-${worker}`,
        envs: [],
      });
    }
    mismatches.push(...workerVarMismatches(worker, config));
    const findings = environmentNameFindings(worker, config, project);
    reserved.push(...findings.reserved);
    if (findings.convention) convention.push(findings.convention);
  }

  // Two kinds of fault, one verdict. `drifted` means this project's own files positively establish
  // something wrong — a stamp that contradicts the directory, or a name a capability's host already owns
  // — and either fails the exit. `convention` is not one of them: it is a report line, and a project
  // carrying nothing but convention notes is `ok`.
  if (mismatches.length > 0 || reserved.length > 0) return { state: "drifted", mismatches, reserved, convention };
  return { state: unreadable ? "could-not-check" : "ok", mismatches: [], reserved: [], convention };
}

/** One mismatch in a sentence — what the stamp does with the wrong name, and what the directory says. */
export function describeWorkerName(mismatch: WorkerNameMismatch): string {
  return mismatch.stamp === "name"
    ? `deploys as ${mismatch.declared}, not ${mismatch.expected}`
    : `stamps events as ${mismatch.declared}, not ${mismatch.expected}`;
}

/** One reserved-name clash in a sentence — the name, and whose it already is. The env is the line's label. */
export function describeReservedWorkerName(clash: ReservedWorkerName): string {
  return `deploys as ${clash.name} — the ${clash.capability} capability's own host Worker. Deploying replaces it.`;
}

/**
 * One Worker still on wrangler's suffix, in two sentences: where it lands, and where the convention puts it.
 *
 * The second sentence is the price, and it is said every time the first one is: this is the line that
 * stops the note reading like an instruction. A rename is a new script, a route moved onto it, and a
 * window where the old name is still answering — so it is a thing to do when it is cheap, or never.
 */
export function describeWorkerNameConvention(note: WorkerNameConvention): string[] {
  const current = note.environments.map((entry) => entry.current).join(", ");
  const convention = note.environments.map((entry) => entry.convention).join(", ");
  return [
    `${note.worker} deploys as ${current}. The kit's shape is <project>-<env>-<worker>: ${convention}.`,
    "Optional. A rename is a new script, a route move, and a window where the old name still answers.",
  ];
}
