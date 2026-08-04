// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { createDatabase, type DatabaseSchema } from "../../data/db";
import { ControlPlaneConnection } from "./connection";
import { ControlPlaneReplay } from "./replay";

/**
 * The connections table. `CamelCasePlugin` snake-cases it to `pithy_controlplane_connections` — the
 * namespace is the single word `controlplane`, matching the migration namespace and the
 * `controlplane/*` error codes, because the prefix pattern admits no hyphen.
 */
export const CONTROL_PLANE_CONNECTIONS_TABLE = "pithyControlplaneConnections";

/**
 * The replay table — spent token ids. Snake-cases to `pithy_controlplane_replays`.
 *
 * In the same database as the connections rather than beside the sessions in KV, because that is what
 * makes the claim a primary-key insert and therefore strongly consistent. See `../replay/guard.ts`.
 */
export const CONTROL_PLANE_REPLAYS_TABLE = "pithyControlplaneReplays";

/**
 * The control-plane tables map. Both are always present: a Worker that composes the seam and has never
 * been connected still needs somewhere for the answer "nobody is connected" to come from, and the
 * replay table must exist before the first management call rather than on first use.
 */
export function controlPlaneTables(): Record<string, z.ZodObject> {
  return {
    [CONTROL_PLANE_CONNECTIONS_TABLE]: ControlPlaneConnection,
    [CONTROL_PLANE_REPLAYS_TABLE]: ControlPlaneReplay,
  };
}

/** The typed Kysely database over the control-plane tables. */
export type ControlPlaneTables = {
  [CONTROL_PLANE_CONNECTIONS_TABLE]: typeof ControlPlaneConnection;
  [CONTROL_PLANE_REPLAYS_TABLE]: typeof ControlPlaneReplay;
};
export type ControlPlaneDatabase = Kysely<DatabaseSchema<ControlPlaneTables>>;

/** Build the control-plane database from the `DB` binding (CamelCasePlugin installed). */
export function controlPlaneDatabase(d1: D1Database): ControlPlaneDatabase {
  return createDatabase(d1, {
    [CONTROL_PLANE_CONNECTIONS_TABLE]: ControlPlaneConnection,
    [CONTROL_PLANE_REPLAYS_TABLE]: ControlPlaneReplay,
  }) as unknown as ControlPlaneDatabase;
}
