// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandAlternatives, pithyCommand, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { isControlPlaneCapability } from "@pithy-sh/core/src/controlPlane/capability";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { resolveWorkersFor } from "../project/composeFor";
import { workerDirName } from "../project/workerIdentity";
import type { ResolvedWorker } from "../project/workerScope";
import type { NextStep } from "../terminal/nextSteps";
import { openConnectionRegistry } from "./registry";

/**
 * **A deploy offers the dashboard to an environment that has none (#757).**
 *
 * A first staging or prod deploy is the moment a management view pays off, and nothing said so. It is an
 * offer, not a `next`: connecting is the person's choice, and it opens a browser sign-in only they can
 * approve. So it lands in `offers`, and only on a fact the run established. Each of these is a no:
 *
 * - **Not a named environment.** `dev` is the local store and a feature environment is gone at merge, so
 *   neither is worth a connection.
 * - **A failed run.** Its failure is the next thing to read.
 * - **No Worker composes the seam, or the composition could not be read.** There is nothing to connect to.
 * - **The registry could not be read.** An unknown is not an absence, and offering a connection that may
 *   already exist sends a person through a sign-in for nothing.
 *
 * The cheap facts go first, so the registry — a D1 read over REST outside `dev` — is asked only when the
 * answer decides something.
 */

/** The two facts the offer reads, as seams so the condition is tested without an account. */
export interface DashboardOfferSeams {
  /** The `apps/` directory of each Worker composing the control-plane seam in `env`, or null when unreadable. */
  seamWorkers: (env: string) => Promise<WorkerDir[] | null>;
  /** Whether `env` has a connection registered. Throws when the registry cannot be read. */
  connected: (env: string, worker: WorkerDir) => Promise<boolean>;
}

export interface DashboardOfferOptions {
  projectDir: string;
  env: string | undefined;
  account: CloudflareAccountSelection | null;
  failed: boolean;
  seams?: DashboardOfferSeams;
}

export async function dashboardOffers(options: DashboardOfferOptions): Promise<NextStep[] | undefined> {
  const { env } = options;
  if (options.failed || env === undefined || env === LOCAL_ENVIRONMENT || env === FEATURE_ENVIRONMENT) {
    return undefined;
  }
  const seams = options.seams ?? defaultSeams(options.projectDir, options.account);
  const workers = await seams.seamWorkers(env).catch(() => null);
  const first = workers?.[0];
  if (workers === null || first === undefined) return undefined;
  const connected = await seams.connected(env, first).catch(() => undefined);
  if (connected !== false) return undefined;

  const why = `${env} is not connected to a dashboard. Connecting opens a browser sign-in, so it is a person's to approve.`;
  return workers.map((worker) => ({
    command: pithyCommand("dashboard connect", { flags: { "--env": env, "--worker": worker } }),
    why: workers.length > 1 ? `${why} Any one of these connects the project.` : why,
  }));
}

/** The real reads: the composition `pithy dashboard connect` resolves, and the row `pithy dashboard status` reads. */
function defaultSeams(projectDir: string, account: CloudflareAccountSelection | null): DashboardOfferSeams {
  return {
    seamWorkers: async (env) => seamWorkerDirs(await resolveWorkersFor(env, { projectDir })),
    connected: async (env, worker) => {
      const registry = await openConnectionRegistry({ projectDir, env, account, worker });
      try {
        return (await registry.read()) !== null;
      } finally {
        await registry.dispose();
      }
    },
  };
}

/** The `apps/` directory of each Worker that composes the control-plane seam, sorted. */
export function seamWorkerDirs(resolved: readonly ResolvedWorker[]): WorkerDir[] {
  return resolved
    .filter((worker) => worker.capabilities.some(isControlPlaneCapability))
    .map(workerDirName)
    .sort();
}

/** The human line for the same offers: one sentence, the commands in code, any one of them enough. */
export function dashboardOfferLine(env: string, offers: readonly NextStep[]): string {
  return `${env} is not connected to a dashboard. Connect it with ${commandAlternatives(offers.map((offer) => offer.command))}.`;
}
