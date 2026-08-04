// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { LeaderboardConfig, type LeaderboardConfigInput, materializeSchedule } from "./config/config";
import { leaderboardTables } from "./data/tables";
import { registerLeaderboardRoutes } from "./http/routes";
import { leaderboard_0001_entries } from "./migrations/0001_entries";
import { leaderboardExampleSeed } from "./seeds/example";
import { PACKAGE_VERSION } from "./version.generated";

/**
 * Where leaderboard's migrations sort in the app database. Unique per database; the registry composes
 * keys like `0400_leaderboard_0001_entries`. Sits after media (300) and audit (250).
 */
export const LEADERBOARD_MIGRATION_ORDER = 400;

export type LeaderboardOptions = LeaderboardConfigInput & {
  /** Mount the routes somewhere other than `/leaderboard`. */
  basePath?: string;
};

export interface LeaderboardCapability extends Capability {
  leaderboardConfig: LeaderboardConfig;
}

/**
 * The leaderboard capability: submit a score, read the standings, read your own rank — across windows.
 *
 * Fully optional. Config, migrations, routes, and bindings arrive only on `pithy add leaderboard`, and
 * `pithy remove leaderboard` is the clean inverse.
 *
 * One store, always: D1. There is no engine flag, because Durable Objects do not fix what a leaderboard
 * actually strains against. A DO bills rows exactly as D1 does, so a rank scan inside one costs the same;
 * it adds request and duration billing D1 does not have; and each object is single-threaded with a soft
 * 1,000 req/s ceiling and the same 10 GB cap, so it does not relieve hot-board serialization either.
 * Scale is a cadence dial (`rank: { materialize }`), which is pure D1. A DO earns its place only when
 * `live: true` ships — as a WebSocket push layer *over* D1, which is a latency play, not a store.
 *
 * `dependsOn` is deliberately empty. Auth is not a peer capability but a seam: the routes read
 * `c.var.auth` through core's `AuthContext`, so without `@pithy-sh/auth` installed every route is denied
 * rather than open. That is the right failure and it needs no dependency edge.
 */
export function leaderboard(options: LeaderboardOptions = { boards: [] }): LeaderboardCapability {
  const { basePath, ...configInput } = options;
  // Parses the board set, and validates every CRON at assembly — a typo fails on deploy, not on the
  // first submission at 3am.
  const resolved = LeaderboardConfig.parse(configInput);

  const migrations: Record<string, Migration> = { "0001_entries": leaderboard_0001_entries };

  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const capability = defineCapability({
    name: "leaderboard",
    // The package version this capability ships at, stamped by `scripts/stampVersions.ts` — a Worker
    // cannot read its own package.json. Reported per capability by the control-plane manifest.
    version: PACKAGE_VERSION,
    requiredBindings,
    config: LeaderboardConfig,
    databases: {
      app: {
        binding: "DB",
        tables: leaderboardTables(),
        migrationOrder: LEADERBOARD_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerLeaderboardRoutes({ config: resolved, basePath }),
    seeds: [leaderboardExampleSeed],
  });

  return Object.assign(capability, { leaderboardConfig: resolved });
}

export function isLeaderboardCapability(capability: Capability): capability is LeaderboardCapability {
  return capability.name === "leaderboard" && "leaderboardConfig" in capability;
}

/**
 * Whether this configuration needs the rank worker deployed.
 *
 * Two things need it: materialized rank (the refresh), and configured retention (the prune). Retention
 * now defaults to keep-all, so a windowed board only needs the worker if it actually sets `retain` or
 * `retainDays` — a board that keeps everything has nothing to prune. A live, keep-all board set needs no
 * worker at all.
 */
export function needsRankWorker(config: LeaderboardConfig): boolean {
  if (materializeSchedule(config) !== undefined) return true;
  return config.boards.some((board) => board.retain !== undefined || board.retainDays !== undefined);
}
