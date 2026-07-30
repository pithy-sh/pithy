// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { createDatabase, type DatabaseSchema } from "../../data/db";
import { ControlPlaneConnection } from "./connection";

/**
 * The connections table. `CamelCasePlugin` snake-cases it to `pithy_controlplane_connections` — the
 * namespace is the single word `controlplane`, matching the migration namespace and the
 * `controlplane/*` error codes, because the prefix pattern admits no hyphen.
 */
export const CONTROL_PLANE_CONNECTIONS_TABLE = "pithyControlplaneConnections";

/**
 * The control-plane tables map. One table, always present: a Worker that composes the seam and has
 * never been connected still needs somewhere for the answer "nobody is connected" to come from.
 */
export function controlPlaneTables(): Record<string, z.ZodObject> {
  return {
    [CONTROL_PLANE_CONNECTIONS_TABLE]: ControlPlaneConnection,
  };
}

/** The typed Kysely database over the control-plane tables. */
export type ControlPlaneTables = {
  [CONTROL_PLANE_CONNECTIONS_TABLE]: typeof ControlPlaneConnection;
};
export type ControlPlaneDatabase = Kysely<DatabaseSchema<ControlPlaneTables>>;

/** Build the control-plane database from the `DB` binding (CamelCasePlugin installed). */
export function controlPlaneDatabase(d1: D1Database): ControlPlaneDatabase {
  return createDatabase(d1, {
    [CONTROL_PLANE_CONNECTIONS_TABLE]: ControlPlaneConnection,
  }) as unknown as ControlPlaneDatabase;
}
