// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { routeGroupsOf } from "@pithy-sh/core/src/openapi/routeGroups";
import { composeFor, resolveWorkersFor } from "./composeFor";
import type { WorkerConfig } from "./config";

/**
 * **A Worker whose route table its own runtime would refuse does not ship.**
 *
 * A capability's routes load on the first request that reaches them, so what `createBackend` cannot see at
 * assembly is refused when the route table is read: a route that opts in as an MCP tool on the wrong method, or
 * two routes sharing an operation (`routeGroupsOf`). The Worker would start, and then answer every MCP request and
 * every control-plane read of its routes with that refusal. So `pithy deploy` assembles each Worker under
 * `apps/` the way it starts, reads its whole route table, and refuses the deploy on the first refusal it meets.
 *
 * Only a refusal is refused. A route module that cannot load outside workerd is left to the Worker and to
 * `pithy contract`, which read the same table; refusing it here would block a deploy over this check's own
 * limits rather than over the Worker.
 */

/** One Worker to read: its directory and its config, evaluated for the environment being deployed. */
export interface RouteTableWorker {
  /** The Worker's directory. Its basename names it in a refusal. */
  readonly dir: string;
  /** The Worker's own `pithy.config.ts`. */
  readonly config: WorkerConfig;
}

/** The refusal reading one Worker's route table meets, or `null` when the table reads cleanly. */
async function routeTableRefusal(worker: RouteTableWorker, environment: string): Promise<ValidationError | null> {
  try {
    await composeFor(environment, async () => {
      const app = createBackend({
        capabilities: worker.config.capabilities,
        ...(worker.config.app ? { app: worker.config.app } : {}),
      });
      await routeGroupsOf(app);
    });
    return null;
  } catch (error) {
    return error instanceof ValidationError ? error : null;
  }
}

/** Refuse when any Worker's route table is one its runtime would refuse. Exit 3, a precondition. */
export async function assertRouteTablesShip(workers: readonly RouteTableWorker[], environment: string): Promise<void> {
  for (const worker of workers) {
    const refusal = await routeTableRefusal(worker, environment);
    if (refusal === null) continue;
    const name = basename(worker.dir);
    throw new PreconditionFailedError(
      {
        message: `${name} will not run as configured: ${refusal.payload.message}`,
        action: refusal.payload.action ?? `Fix the route in apps/${name}, then deploy again.`,
        detail:
          `Reading the ${name} Worker's route table for ${environment} refused it. ${refusal.payload.detail ?? ""}`.trim(),
      },
      { cause: refusal },
    );
  }
}

/**
 * {@link assertRouteTablesShip} for `pithy deploy`: every Worker under `apps/`, composed for `environment`. A
 * project whose Workers will not compose is not refused here; the deploy's own composition reports it.
 */
export async function assertRouteTablesDeployable(projectDir: string, environment: string): Promise<void> {
  const resolved = await resolveWorkersFor(environment, { projectDir }).catch(() => null);
  if (resolved === null) return;
  await assertRouteTablesShip(resolved, environment);
}
