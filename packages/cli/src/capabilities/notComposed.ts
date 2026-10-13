// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { workerDirName } from "../project/workerIdentity";
import { configuredWorkerDirs } from "../project/workers";
import {
  type AddPlan,
  addAction,
  addPlan,
  addSecretsPlan,
  composedBy,
  projectAddFacts,
  withAddFix,
} from "./addCommand";
import { KIT_ADD_FACTS } from "./kitAddFacts.generated";

/**
 * **A capability the project does not compose is a precondition, not a bad call (#697).**
 *
 * `pithy email provision` in a project with no `email` was right as typed; what it depends on is missing, and
 * `pithy add email` is the step that puts it there. So it exits 3 with that command as its `fix`, like every
 * other "run this first" — never 2, which tells a script that a different spelling of the same call would
 * have worked.
 *
 * A caller that *named* a Worker which does not compose it made a different mistake — another `--worker` is
 * the fix — and stays a usage error at its own site (`project/capabilityWorker.ts`).
 */

/** Where the refusal is, so the `fix` can name it. */
export interface AddFixScope {
  /** The project root: where the capability's manifest and the Workers are read from. */
  projectDir: string;
  /** The Worker the refusal is about, by its directory. Absent when it is about the project. */
  workerDir?: string | undefined;
  /** Every Worker's directory, when the caller resolved them already. Discovered when absent. */
  workerDirs?: readonly string[] | undefined;
}

/**
 * **The `pithy add` lines for a capability this scope lacks** (`addCommand.ts`'s plan): into the Worker the
 * refusal is about, or one command per configured Worker when it is about the project.
 */
export function resolveAdd(capability: string, scope: AddFixScope): AddPlan {
  const { projectDir, workerDir } = scope;
  const dirs = workerDir !== undefined ? [workerDir] : (scope.workerDirs ?? configuredWorkerDirs(projectDir));
  return addPlan({
    capability,
    workers: dirs.map((dir) => workerDirName({ dir })),
    factsFor: projectAddFacts(projectDir),
    composed: workerDir === undefined ? undefined : composedBy(workerDir, Object.keys(KIT_ADD_FACTS)),
  });
}

/**
 * The refusal for a capability nothing composes: `core/precondition_failed`, exit 3, with the `pithy add` that
 * composes it as its `fix` when exactly one runs as written.
 *
 * `action` is written around the command rather than beside it (#711): it is handed the commands in code, so the
 * sentence names the `fix` exactly — or, where a person must decide something first, it is that sentence instead.
 */
export function capabilityNotComposed(
  capability: string,
  refusal: { message: string; action: (add: string) => string; detail?: string },
  scope: AddFixScope,
  cause?: unknown,
): PreconditionFailedError {
  const plan = resolveAdd(capability, scope);
  const payload = { ...refusal, action: addAction(plan, refusal.action) };
  return withAddFix(new PreconditionFailedError(payload, cause === undefined ? undefined : { cause }), plan);
}

/**
 * **No `SECRETS_STORE_ID` recorded, and the command that records it (#711)** — `pithy add secrets`, offered for the
 * Workers that compose secrets already. `why` says what this run needed the store for.
 */
export function secretsStoreIdMissing(projectDir: string, why?: string): PreconditionFailedError {
  const plan = addSecretsPlan(projectDir);
  const error = new PreconditionFailedError({
    message: "The CF Secrets Store id is missing.",
    action: addAction(plan, (add) => `Run ${add} to record SECRETS_STORE_ID${why === undefined ? "" : ` (${why})`}.`),
  });
  return withAddFix(error, plan);
}
