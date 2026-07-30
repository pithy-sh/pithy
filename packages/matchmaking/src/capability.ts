// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { MatchmakingConfig, type MatchmakingConfigInput } from "./config/config";
import { matchmakingTables } from "./data/tables";
import { registerMatchmakingRoutes } from "./http/routes";
import { ROOM_PREFIX, Room, RoomKey } from "./kv/rooms";
import { matchmaking_0001_matchmaking } from "./migrations/0001_matchmaking";
import { matchmakingExampleSeed } from "./seeds/example";

/**
 * Where matchmaking's migrations sort in the app database. Unique per database; the registry composes keys
 * like `0700_matchmaking_0001_matchmaking`. Sits after rating (600).
 */
export const MATCHMAKING_MIGRATION_ORDER = 700;

export type MatchmakingOptions = MatchmakingConfigInput & {
  /** Mount the routes somewhere other than `/matchmaking`. */
  basePath?: string;
};

export interface MatchmakingCapability extends Capability {
  matchmakingConfig: MatchmakingConfig;
}

/**
 * The matchmaking capability: find competitors and land in an authoritative multiplayer session. Room
 * codes, direct invites, a symmetric friend graph, and an open queue bucketed by region and skill —
 * every path outputs a `@pithy-sh/multiplayer` session id.
 *
 * Optional peers, all reached as seams (never hard `dependsOn`): `@pithy-sh/auth` (identity — reads
 * `c.var.auth`, resolves invite targets), `@pithy-sh/rating` (skill for queue bucketing), and
 * `@pithy-sh/multiplayer` (the `SESSIONS` binding, read at runtime to mint sessions). Absent any of them,
 * matchmaking degrades: denied without auth, region-only queue without rating, session-minting disabled
 * without multiplayer.
 */
export function matchmaking(options: MatchmakingOptions = { games: [] }): MatchmakingCapability {
  const { basePath, ...configInput } = options;
  const resolved = MatchmakingConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_matchmaking": matchmaking_0001_matchmaking };

  const requiredBindings: BindingSpecInput[] = [
    { type: "d1", name: "DB" },
    { type: "kv", name: "MATCHMAKING" },
    { type: "durable_object", name: "QUEUE", className: "MatchmakingQueue" },
    { type: "durable_object", name: "PRESENCE", className: "MatchmakingPresence" },
  ];

  const capability = defineCapability({
    name: "matchmaking",
    requiredBindings,
    config: MatchmakingConfig,
    databases: {
      app: {
        binding: "DB",
        tables: matchmakingTables(),
        migrationOrder: MATCHMAKING_MIGRATION_ORDER,
        migrations,
      },
    },
    kvNamespaces: {
      matchmaking: {
        binding: "MATCHMAKING",
        stores: {
          rooms: { prefix: ROOM_PREFIX, key: RoomKey, value: Room },
        },
      },
    },
    routes: registerMatchmakingRoutes({ config: resolved, basePath }),
    seeds: [matchmakingExampleSeed],
  });

  return Object.assign(capability, { matchmakingConfig: resolved });
}

export function isMatchmakingCapability(c: Capability): c is MatchmakingCapability {
  return c.name === "matchmaking" && "matchmakingConfig" in c;
}
