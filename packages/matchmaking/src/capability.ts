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
import { type MatchmakingPeers, matchmakingPeers } from "./peers";
import { matchmakingExampleSeed } from "./seeds/example";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

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
 * matchmaking degrades: denied without auth, session-minting disabled without multiplayer. A game with a
 * `skillPool` is refused at assembly without rating, rather than bucketing by region alone and saying nothing.
 */
export function matchmaking(options: MatchmakingOptions = { games: [] }): MatchmakingCapability {
  const { basePath, ...configInput } = options;
  const resolved = MatchmakingConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_matchmaking": matchmaking_0001_matchmaking };

  const requiredBindings: BindingSpecInput[] = [
    { type: "d1", name: "DB" },
    { type: "kv", name: "MATCHMAKING" },
    {
      type: "durable_object",
      name: "QUEUE",
      className: "MatchmakingQueue",
      classModule: "@pithy-sh/matchmaking/src/queue/durableObject",
    },
    {
      type: "durable_object",
      name: "PRESENCE",
      className: "MatchmakingPresence",
      classModule: "@pithy-sh/matchmaking/src/presence/durableObject",
    },
  ];

  // Filled once by `compose`, which runs after this factory — so the routes are handed a reader, not a value.
  let peers: MatchmakingPeers = {};

  const capability = defineCapability({
    name: "matchmaking",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
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
    // The optional peers — auth for an invite, rating for a skill bucket — found among the composed
    // capabilities rather than imported (#645), and refused here when the config needs one this Worker cannot
    // reach. See `peers.ts`.
    compose: ({ capabilities }) => {
      peers = matchmakingPeers(capabilities, resolved);
    },
    routes: registerMatchmakingRoutes({ config: resolved, basePath, peers: () => peers }),
    seeds: [matchmakingExampleSeed],
  });

  return Object.assign(capability, { matchmakingConfig: resolved });
}

export function isMatchmakingCapability(c: Capability): c is MatchmakingCapability {
  return c.name === "matchmaking" && "matchmakingConfig" in c;
}
