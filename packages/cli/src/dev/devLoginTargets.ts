// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { allCapabilities, loadWorkerConfig } from "../project/config";
import { parseWorkerManifest } from "../project/workerManifest";
import type { DevLoginTarget } from "./devLogin";

/**
 * Which running worker `l` opens, in a project that runs more than one.
 *
 * **The rule is "the worker that carries the route", not "the worker with the UI"** — and the reason is
 * the cookie, not preference. `Set-Cookie` is scoped to the origin that sent it, and every worker in a
 * dev session is a different `localhost:<port>`. Opening a worker that does not compose auth would 404
 * on {@link DEV_LOGIN_ROUTE}; opening one that does, and then browsing to a *different* worker, leaves
 * the browser signed out on the second origin. So the candidate set is exactly the workers that compose
 * auth, which is a fact read off each worker's own `pithy.config.ts` rather than guessed.
 *
 * **The UI block breaks a tie, and only a tie.** `pithy ui add` records `ui` in `pithy.worker.jsonc`,
 * and in the ordinary Pithy project that block sits on the same worker that serves the API — one origin,
 * one cookie, one thing to look at. Where two workers both compose auth and one of them is the one with
 * a front end, that is the one a developer meant. Where the signal does not decide — neither carries a
 * UI, or both do — nothing is narrowed and the caller prints the choices. A silent guess between two
 * origins is the failure this avoids: it looks like the feature worked, and the browser is signed in to
 * the wrong one.
 *
 * Both probes are non-fatal. A worker whose `pithy.config.ts` will not import composes nothing as far as
 * this is concerned; wrangler reports that file's failure, loudly, and inventing a second complaint here
 * would only bury it.
 */

/** A started worker, as this module needs it: its label, its directory, and where it answers. */
export interface StartedWorkerDir {
  name: string;
  /** The `apps/<name>/` directory holding its `pithy.config.ts` and `pithy.worker.jsonc`. */
  dir: string;
  origin: string;
}

/** Everything {@link devLoginTargets} needs. Both probes default to reading the worker's own files. */
export interface DevLoginTargetOptions {
  started: readonly StartedWorkerDir[];
  /** Does this worker compose the auth capability, and therefore carry the route? */
  composesAuth?: (dir: string) => Promise<boolean>;
  /** Does this worker carry a front end (`ui` in its `pithy.worker.jsonc`)? Breaks a tie, nothing more. */
  hasUi?: (dir: string) => Promise<boolean>;
}

/** Whether a worker's own config composes auth. A config that will not load composes nothing. */
async function composesAuthDefault(dir: string): Promise<boolean> {
  try {
    return allCapabilities(await loadWorkerConfig(dir)).some((capability) => capability.name === "auth");
  } catch {
    return false;
  }
}

/** Whether a worker carries a front end. The `ui` block's presence *is* the signal (see `ui/workerUi.ts`). */
async function hasUiDefault(dir: string): Promise<boolean> {
  try {
    return (await parseWorkerManifest(dir))?.ui !== undefined;
  } catch {
    return false;
  }
}

/** Run a predicate over every started worker, keeping the started order. */
async function keep(
  workers: readonly StartedWorkerDir[],
  predicate: (dir: string) => Promise<boolean>,
): Promise<StartedWorkerDir[]> {
  const verdicts = await Promise.all(
    workers.map(async (worker) => {
      try {
        return await predicate(worker.dir);
      } catch {
        return false;
      }
    }),
  );
  return workers.filter((_worker, index) => verdicts[index] === true);
}

/** The workers `l` may open, in started order — one to open, several to choose from, or none. */
export async function devLoginTargets(options: DevLoginTargetOptions): Promise<DevLoginTarget[]> {
  const carriers = await keep(options.started, options.composesAuth ?? composesAuthDefault);
  if (carriers.length <= 1) return carriers.map(({ name, origin }) => ({ name, origin }));

  const withUi = await keep(carriers, options.hasUi ?? hasUiDefault);
  const chosen = withUi.length === 1 ? withUi : carriers;
  return chosen.map(({ name, origin }) => ({ name, origin }));
}
