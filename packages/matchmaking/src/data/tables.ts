// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { Friendship } from "./friend";
import { Invite } from "./invite";

/**
 * The matchmaking capability's D1 tables: `pithy_matchmaking_invites` (direct invites) and
 * `pithy_matchmaking_friends` (the friend graph). Room codes live in KV, not D1. Table names are
 * camelCase constants; core's `createDatabase` installs the mandatory `CamelCasePlugin`.
 */

export const MATCHMAKING_INVITES_TABLE = "pithyMatchmakingInvites";
export const MATCHMAKING_FRIENDS_TABLE = "pithyMatchmakingFriends";

export function matchmakingTables(): Record<string, z.ZodObject> {
  return {
    [MATCHMAKING_INVITES_TABLE]: Invite,
    [MATCHMAKING_FRIENDS_TABLE]: Friendship,
  };
}

type MatchmakingTables = {
  [MATCHMAKING_INVITES_TABLE]: typeof Invite;
  [MATCHMAKING_FRIENDS_TABLE]: typeof Friendship;
};
export type MatchmakingDatabase = Kysely<DatabaseSchema<MatchmakingTables>>;

export function matchmakingDatabase(d1: D1Database): MatchmakingDatabase {
  return createDatabase(d1, {
    [MATCHMAKING_INVITES_TABLE]: Invite,
    [MATCHMAKING_FRIENDS_TABLE]: Friendship,
  }) as unknown as MatchmakingDatabase;
}
