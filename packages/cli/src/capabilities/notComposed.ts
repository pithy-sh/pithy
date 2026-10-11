// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { type PithyError, PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { discoverWorkers } from "../project/workers";
import { withFix } from "../terminal/exitClass";
import { installedManifest } from "./manifests";
import { isRequired } from "./requiredOptions";

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
 * The `--worker` a `fix` names: the apps/ directory, which every `--worker` takes. `undefined` when the
 * project has one Worker and none needs naming, and `null` when no single Worker can be named honestly —
 * several Workers and a refusal about the project, which `pithy add` would refuse as ambiguous.
 */
async function fixWorker(scope: AddFixScope): Promise<string | undefined | null> {
  if (scope.workerDir !== undefined) return basename(scope.workerDir);
  const dirs = scope.workerDirs ?? (await configuredWorkerDirs(scope.projectDir));
  return dirs.length === 1 ? undefined : null;
}

/** The discovered Workers `pithy add` can wire into: the ones carrying a `pithy.config.ts`. */
async function configuredWorkerDirs(projectDir: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const target of await discoverWorkers(projectDir)) {
    try {
      await access(join(target.dir, "pithy.config.ts"));
      dirs.push(target.dir);
    } catch {
      // A dev-only process, which composes nothing and is no `--worker` target.
    }
  }
  return dirs;
}

/** What a `pithy add` that runs as written has to say, read rather than assumed. */
interface AddFixParts {
  /** The `--worker` value, or `undefined` when the project has one Worker and none is needed. */
  worker: string | undefined;
  /** Whether `--with-prerequisites` is needed. */
  prerequisites: boolean;
}

/**
 * **The `pithy add` that composes `capability`, runnable as written with nobody to ask** — or `null` when no
 * such command exists.
 *
 * Each part is read, never assumed. `--worker` names the apps/ directory whenever the project has more than
 * one Worker, because without it `pithy add` asks which, and an agent cannot answer. `--with-prerequisites`
 * comes from the manifest's `peerCapabilities`, because without it a capability with prerequisites refuses
 * with `input/required`; a manifest that is not installed yet cannot rule them out, and the flag composes
 * nothing that is not missing. A required option — one the manifest states no default for — has no value
 * the kit may pick (#412), so a capability that declares one gets no `fix` at all, and its `action` says the
 * rest.
 */
async function addFixParts(capability: string, scope: AddFixScope): Promise<AddFixParts | null> {
  const worker = await fixWorker(scope);
  if (worker === null) return null;
  const manifest = await installedManifest(scope.projectDir, capability);
  if (manifest?.configOptions.some(isRequired)) return null;
  return { worker, prerequisites: manifest === undefined || manifest.peerCapabilities.length > 0 };
}

/**
 * Attach the `pithy add` that composes `capability` to `error`, when one runs as written; hand `error` back
 * either way. Each shape is written out whole, so `ci/actionLines.test.ts` reads every command and flag.
 */
export async function withAddFix<E extends PithyError>(error: E, capability: string, scope: AddFixScope): Promise<E> {
  const parts = await addFixParts(capability, scope);
  if (parts === null) return error;
  const { worker, prerequisites } = parts;
  if (worker !== undefined && prerequisites) {
    return withFix(error, { fix: `pithy add ${capability} --worker ${worker} --with-prerequisites` });
  }
  if (worker !== undefined) return withFix(error, { fix: `pithy add ${capability} --worker ${worker}` });
  if (prerequisites) return withFix(error, { fix: `pithy add ${capability} --with-prerequisites` });
  return withFix(error, { fix: `pithy add ${capability}` });
}

/**
 * The refusal for a capability nothing composes: `core/precondition_failed`, exit 3, with {@link withAddFix}'s
 * `fix` when there is one.
 */
export async function capabilityNotComposed(
  capability: string,
  refusal: { message: string; action: string; detail?: string },
  scope: AddFixScope,
  cause?: unknown,
): Promise<PreconditionFailedError> {
  const error = new PreconditionFailedError(refusal, cause === undefined ? undefined : { cause });
  return withAddFix(error, capability, scope);
}
