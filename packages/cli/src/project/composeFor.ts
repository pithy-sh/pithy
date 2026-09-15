// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { ENVIRONMENT_VAR } from "@pithy-sh/core/src/worker/identity";
import { cachedEvaluation, type LoadWorkerConfigOptions, loadWorkerConfig, type WorkerConfig } from "./config";
import {
  type CapabilitySet,
  capabilitySetOf,
  type ResolvedWorker,
  type ResolveOptions,
  type ResolveSingleOptions,
  resolveSingleWorker,
  resolveWorkerSet,
  resolveWorkers,
  type WorkerSet,
} from "./workerScope";

/**
 * **Compose for an environment — the one place a CLI composition is told which one (#595).**
 *
 * A Worker's `pithy.config.ts` is code, and it may ask which environment it is being composed for:
 * `pithy init` scaffolds `originFor(compositionEnvironment(), DOMAINS)` into every one, `@pithy-sh/auth`
 * mounts its dev-login route only when the answer is `dev`, and an adopter may enable a provider, a
 * migration or a whole capability for production alone. Inside a Worker the answer is the script's own
 * `vars.ENVIRONMENT`, which workerd puts in `process.env` before the config runs. In the CLI nothing puts
 * it anywhere, so a composition the CLI takes answers for **no** environment.
 *
 * That was right for exactly the commands that are not about one, and wrong for every command that is.
 * `pithy migrate --env staging`, `pithy upgrade --env staging` and `pithy deploy --env staging`'s pending
 * count all counted and applied the migrations of a composition built for none, while reporting the
 * environment they were asked about. Two modules had already found the same hole and closed it for
 * themselves — `ui/routeAllowlist.ts` (#255) and `capabilities/secretApplicability.ts` (#541) — each with
 * its own stamp-and-restore. A third producer is the signal that the rule belongs to the thing being
 * called, so it lives here, and `ci/environmentCompositions.test.ts` holds every composition to it.
 *
 * ## What composing for an environment takes
 *
 * 1. **`ENVIRONMENT` stamped for the composition, and restored afterwards.** Restored, not defaulted: a
 *    variable this process never had must not exist afterwards, or the next thing to read it in this run
 *    is told something the project never said.
 * 2. **A config evaluated under that stamp.** Stamping is not enough on its own, because the module cache
 *    is keyed on the path: a config this process already imported for another environment comes back as
 *    that environment's evaluation. {@link EnvironmentLoader} takes the cache when it holds this
 *    environment's evaluation (or nothing yet, which a stamped import then makes this environment's), and
 *    re-reads the file otherwise.
 * 3. **One environment at a time.** `process.env` is one per process. Two compositions overlapping across
 *    an `await` would each see the other's stamp and restore them out of order, leaving one behind for the
 *    rest of the run. So they queue. A composition nested inside one for the **same** environment runs in
 *    place — the queue would otherwise deadlock on itself — and one nested inside a **different**
 *    environment's is refused, because no answer to it can be true.
 *
 * ## What it does not reach
 *
 * - **A re-read re-evaluates `pithy.config.ts` alone.** A module the config imports is taken from the cache
 *   as ever, so an environment read at the top of `./src/app.ts` keeps its first answer. That is the fresh
 *   copy's limit, stated where it is written (`importFreshCopy` in `project/config.ts`).
 * - **Anything reading `process.env` while a composition is awaiting sees its stamp.** The window is the
 *   composition itself, and nothing a composing command does in that window is about another environment.
 */

/**
 * Load one Worker's config **as evaluated for the environment being composed**. Hands out the same
 * `fresh` option `loadWorkerConfig` takes, for the caller that has just written the file.
 */
export type EnvironmentLoader = (workerDir: string, options?: LoadWorkerConfigOptions) => Promise<WorkerConfig>;

/** The environment the running composition is for, carried across its `await`s. */
const composing = new AsyncLocalStorage<string>();

/** The tail of the queue compositions wait in. Never rejects: a failed composition is its caller's to read. */
let tail: Promise<unknown> = Promise.resolve();

/** A config loader that answers for `environment` — see point 2 above. */
function loaderFor(environment: string): EnvironmentLoader {
  return (workerDir, options) => {
    const cached = cachedEvaluation(workerDir);
    const stale = cached !== undefined && cached.environment !== environment;
    return loadWorkerConfig(workerDir, { fresh: options?.fresh === true || stale });
  };
}

/** Refuse a composition asked for inside one for another environment. */
function assertNotInside(environment: string): string | undefined {
  const current = composing.getStore();
  if (current !== undefined && current !== environment) {
    throw new InternalError({
      message: "A composition cannot be for two environments at once.",
      detail: `composeFor(${JSON.stringify(environment)}) was called inside composeFor(${JSON.stringify(current)}).`,
    });
  }
  return current;
}

/** Put `ENVIRONMENT` back exactly as it was found. */
function restore(previous: string | undefined): void {
  if (previous === undefined) delete process.env[ENVIRONMENT_VAR];
  else process.env[ENVIRONMENT_VAR] = previous;
}

/**
 * Run `compose` as a composition for `environment`: `ENVIRONMENT` stamped, a loader that evaluates configs
 * under the stamp, and no other composition overlapping it.
 */
export function composeFor<T>(environment: string, compose: (load: EnvironmentLoader) => Promise<T>): Promise<T> {
  if (assertNotInside(environment) !== undefined) return compose(loaderFor(environment));
  const run = tail.then(() =>
    composing.run(environment, async () => {
      const previous = process.env[ENVIRONMENT_VAR];
      process.env[ENVIRONMENT_VAR] = environment;
      try {
        return await compose(loaderFor(environment));
      } finally {
        restore(previous);
      }
    }),
  );
  tail = run.catch(() => undefined);
  return run;
}

/**
 * The synchronous half, for a composition whose environment is read at **registration** rather than at
 * import — `createBackend` over a config already loaded, which is `ui/routeAllowlist.ts`'s case.
 *
 * It needs no queue: nothing else runs while it does. It restores before it returns, so an asynchronous
 * composition it lands between the `await`s of finds its own stamp exactly where it left it.
 */
export function composeForSync<T>(environment: string, compose: () => T): T {
  assertNotInside(environment);
  const previous = process.env[ENVIRONMENT_VAR];
  process.env[ENVIRONMENT_VAR] = environment;
  try {
    return composing.run(environment, compose);
  } finally {
    restore(previous);
  }
}

/** Every Worker in the project, composed for `environment`. {@link resolveWorkers}, told which one. */
export function resolveWorkersFor(
  environment: string,
  options: ResolveOptions & { worker?: string },
): Promise<ResolvedWorker[]> {
  return composeFor(environment, (load) => resolveWorkers({ ...options, loadConfig: options.loadConfig ?? load }));
}

/** The one Worker a command acts on, composed for `environment`. {@link resolveSingleWorker}, told which one. */
export function resolveSingleWorkerFor(environment: string, options: ResolveSingleOptions): Promise<ResolvedWorker> {
  return composeFor(environment, (load) => resolveSingleWorker({ ...options, loadConfig: options.loadConfig ?? load }));
}

/**
 * Every Worker in the project composed for `environment`, or why that set is unknowable.
 * {@link resolveWorkerSet}, told which one — for a caller deriving policy from the whole set.
 */
export function resolveWorkerSetFor(environment: string, options: ResolveOptions): Promise<WorkerSet> {
  return composeFor(environment, (load) => resolveWorkerSet({ ...options, loadConfig: options.loadConfig ?? load }));
}

/**
 * Every capability composed anywhere in the project for `environment`, or why that set is unknowable.
 * `projectCapabilitySet`, told which one.
 */
export async function projectCapabilitySetFor(
  environment: string,
  projectDir: string,
  seams: Omit<ResolveOptions, "projectDir"> = {},
): Promise<CapabilitySet> {
  return capabilitySetOf(await resolveWorkerSetFor(environment, { projectDir, ...seams }));
}
