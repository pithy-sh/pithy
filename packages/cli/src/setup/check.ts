// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type AvailableManifests, composedManifests } from "../capabilities/manifests";
import { missingPrerequisites } from "../capabilities/prerequisites";
import { resolveWorkerSetFor, resolveWorkersFor } from "../project/composeFor";
import { loadProject, requireProjectName } from "../project/config";
import { isUnknown, type ResolvedWorker, type WorkerSet } from "../project/workerScope";

/**
 * **`pithy setup`'s second step: is this a project setup can finish? (#764)**
 *
 * The dev half of `pithy doctor`, and only the half that decides whether anything after it can work: the
 * root config parses and names the project, every Worker's `pithy.config.ts` loads — which is every
 * capability it composes being installed, since loading one imports it — and every composed capability has
 * the peers its manifest declares. Composed for `dev`, because `dev` is the only environment setup is about.
 *
 * **Nothing here reaches an account, and nothing here writes.** Doctor's other half — deployed migrations,
 * the Cloudflare probe, provisioning — is a person's concern on the way to staging, and none of it stops a
 * clone running on the machine it was cloned to.
 *
 * **A failure is the end of the run, said once.** Every problem the check found is in one refusal, so a
 * clone with two broken Workers learns both the first time rather than one per run.
 */

/** What a passing check established. */
export interface CheckedProject {
  /** The root `pithy.config.ts` `name` — every local store this run writes is keyed on it. */
  project: string;
  /** Every Worker, composed for `dev`. */
  workers: ResolvedWorker[];
}

/** What {@link checkProject} needs. Both seams default to the real project. */
export interface CheckProjectOptions {
  /** The project root. */
  projectDir: string;
  /** Resolve every Worker, composed for `dev`. A seam for tests that have no installable capability. */
  resolve?: (projectDir: string) => Promise<WorkerSet>;
  /** Every manifest one Worker can reach. Defaults to {@link composedManifests}. */
  manifests?: (projectDir: string, workerDir: string) => Promise<AvailableManifests>;
}

/**
 * Every Worker, composed for `dev`, or why that set cannot be known.
 *
 * **A config that will not load is rethrown as the loader raised it.** The set states it in one line, the
 * loader's message alone, and the message is only `Could not load <path>.` — the action beside it is what
 * names the uninstalled package or the syntax error, and on a fresh clone that is the whole answer. So the
 * set is asked first, and only when it is unknowable is it resolved once more, in the form that throws.
 */
async function resolveForDev(projectDir: string): Promise<WorkerSet> {
  const set = await resolveWorkerSetFor(LOCAL_ENVIRONMENT, { projectDir });
  if (isUnknown(set)) await resolveWorkersFor(LOCAL_ENVIRONMENT, { projectDir });
  return set;
}

/** Check the project. Returns what it established, or throws one refusal naming every problem. */
export async function checkProject(options: CheckProjectOptions): Promise<CheckedProject> {
  const { projectDir } = options;
  // The root first, and on its own: without a name there is no secrets file, no port key and no store to
  // write, so there is nothing a Worker could add to the answer.
  const project = requireProjectName(await loadProject(projectDir));

  const resolve = options.resolve ?? resolveForDev;
  // A config that will not load, or a Worker with none, is an unknowable set carrying the sentence that
  // says why — the uninstalled package, the syntax error, the missing file.
  const set = await resolve(projectDir);
  const workers = isUnknown(set) ? [] : set;
  const manifestsFor = options.manifests ?? composedManifests;

  const problems: string[] = [];
  if (isUnknown(set)) problems.push(set.unknown);
  for (const worker of workers) {
    const { manifests, faults } = await manifestsFor(projectDir, worker.dir);
    for (const fault of faults) {
      problems.push(`${fault.package} has a pithy.manifest.json that cannot be used: ${fault.reason}.`);
    }
    const composed = new Set(worker.capabilities.map((capability) => capability.name));
    for (const { capability, requires } of missingPrerequisites(manifests, composed)) {
      problems.push(`${worker.name} composes ${capability}, which requires ${requires}.`);
    }
  }

  if (problems.length > 0) {
    throw new ValidationError({
      message: "The project check failed, so setup stopped before writing anything.",
      action: `${[...new Set(problems)].join(" ")} Fix that, then run ${commandName("setup")} again.`,
    });
  }
  return { project, workers };
}
