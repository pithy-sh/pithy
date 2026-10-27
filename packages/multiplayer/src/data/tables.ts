// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { MultiplayerResult } from "./result";
import { MultiplayerSessionEntry } from "./session";
import { MultiplayerVoidKey } from "./voidKey";

/** The results table. `CamelCasePlugin` snake-cases it to `pithy_multiplayer_results` in the DDL. */
export const MULTIPLAYER_RESULTS_TABLE = "pithyMultiplayerResults";

/** The session index. `CamelCasePlugin` snake-cases it to `pithy_multiplayer_sessions` in the DDL. */
export const MULTIPLAYER_SESSIONS_TABLE = "pithyMultiplayerSessions";

/** Every key spent on a void. `CamelCasePlugin` snake-cases it to `pithy_multiplayer_void_keys` in the DDL. */
export const MULTIPLAYER_VOID_KEYS_TABLE = "pithyMultiplayerVoidKeys";

/**
 * The multiplayer tables map: the durable result log, the index of sessions in flight, and every key spent voiding a
 * result. Live session state —
 * membership, hidden commits, the deadline — lives in each session's Durable Object.
 */
export function multiplayerTables(): Record<string, z.ZodObject> {
  return {
    [MULTIPLAYER_RESULTS_TABLE]: MultiplayerResult,
    [MULTIPLAYER_SESSIONS_TABLE]: MultiplayerSessionEntry,
    [MULTIPLAYER_VOID_KEYS_TABLE]: MultiplayerVoidKey,
  };
}

/** The typed Kysely database over the multiplayer tables. */
export type MultiplayerTables = {
  [MULTIPLAYER_RESULTS_TABLE]: typeof MultiplayerResult;
  [MULTIPLAYER_SESSIONS_TABLE]: typeof MultiplayerSessionEntry;
  [MULTIPLAYER_VOID_KEYS_TABLE]: typeof MultiplayerVoidKey;
};
export type MultiplayerDatabase = Kysely<DatabaseSchema<MultiplayerTables>>;

/** Build the multiplayer database from the `DB` binding (CamelCasePlugin installed). */
export function multiplayerDatabase(d1: D1Database): MultiplayerDatabase {
  return createDatabase(d1, multiplayerTables()) as unknown as MultiplayerDatabase;
}
