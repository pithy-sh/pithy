// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { kebab } from "@pithy-sh/core/src/naming/resource";
import { loadProject } from "../project/config";
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

/** What `doctor` learned about this project's worker names. */
export interface WorkerNameCheck {
  state: WorkerNameState;
  mismatches: WorkerNameMismatch[];
}

/** The `wrangler.jsonc` keys this reads: the script name, and the `WORKER` var in every stanza. */
interface NamedWorkerConfig {
  name?: string;
  vars?: Record<string, string | undefined>;
  env?: Record<string, NamedWorkerConfig | undefined>;
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
    return { state: "could-not-check", mismatches: [] };
  }

  const project = await configuredProject(projectDir);
  const mismatches: WorkerNameMismatch[] = [];
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
  }

  if (mismatches.length > 0) return { state: "drifted", mismatches };
  return { state: unreadable ? "could-not-check" : "ok", mismatches: [] };
}

/** One mismatch in a sentence — what the stamp does with the wrong name, and what the directory says. */
export function describeWorkerName(mismatch: WorkerNameMismatch): string {
  return mismatch.stamp === "name"
    ? `deploys as ${mismatch.declared}, not ${mismatch.expected}`
    : `stamps events as ${mismatch.declared}, not ${mismatch.expected}`;
}
