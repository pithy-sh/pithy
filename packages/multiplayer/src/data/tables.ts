// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { MultiplayerResult } from "./result";

/** The results table. `CamelCasePlugin` snake-cases it to `pithy_multiplayer_results` in the DDL. */
export const MULTIPLAYER_RESULTS_TABLE = "pithyMultiplayerResults";

/** The multiplayer tables map — just the durable result log; live session state lives in the Durable Object. */
export function multiplayerTables(): Record<string, z.ZodObject> {
  return { [MULTIPLAYER_RESULTS_TABLE]: MultiplayerResult };
}

/** The typed Kysely database over the multiplayer tables. */
export type MultiplayerTables = {
  [MULTIPLAYER_RESULTS_TABLE]: typeof MultiplayerResult;
};
export type MultiplayerDatabase = Kysely<DatabaseSchema<MultiplayerTables>>;

/** Build the multiplayer database from the `DB` binding (CamelCasePlugin installed). */
export function multiplayerDatabase(d1: D1Database): MultiplayerDatabase {
  return createDatabase(d1, { [MULTIPLAYER_RESULTS_TABLE]: MultiplayerResult }) as unknown as MultiplayerDatabase;
}
