// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import "./algorithm/builtins";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { Migration } from "kysely/migration";
import { RatingConfig, type RatingConfigInput, type ResolvedRatingGame, validateRatingGames } from "./config/config";
import { ratingTables } from "./data/tables";
import { registerRatingRoutes } from "./http/routes";
import { rating_0001_rating } from "./migrations/0001_rating";
import { ratingExampleSeed } from "./seeds/example";

/**
 * Where rating's migrations sort in the app database. Unique per database; the registry composes keys like
 * `0600_rating_0001_rating`. Sits after multiplayer (500).
 */
export const RATING_MIGRATION_ORDER = 600;

export type RatingOptions = RatingConfigInput & {
  /** Mount the routes somewhere other than `/rating`. */
  basePath?: string;
};

export interface RatingCapability extends Capability {
  ratingConfig: RatingConfig;
  ratingGames: ResolvedRatingGame[];
}

/**
 * The rating capability: a per-player store of two distinct numbers — a skill rating (MMR, the
 * matchmaking input, up and down and hideable) and a monotonic experience total (XP, the visible
 * progression) — across named pools, with a pluggable rating algorithm per game.
 *
 * Fully optional. Config, migrations, routes, and the `DB` binding arrive only on `pithy add rating`.
 *
 * `dependsOn` is deliberately empty. Auth is a seam, not a peer: the routes read `c.var.auth` through
 * core's `AuthContext`, so without `@pithy-sh/auth` installed every route is denied rather than open —
 * the right failure, needing no dependency edge (the leaderboard pattern). The built-in algorithms
 * register on import; wiring a 1v1-only algorithm to an N-player game fails here, at assembly.
 */
export function rating(options: RatingOptions = { games: [] }): RatingCapability {
  const { basePath, ...configInput } = options;
  const resolved = RatingConfig.parse(configInput);
  // Resolves every game's algorithm and rejects an unknown algorithm, an out-of-range roster, a team
  // format on a non-team algorithm, or bad `algoParams` — on deploy, not on the first recorded game.
  const games = validateRatingGames(resolved);

  const migrations: Record<string, Migration> = { "0001_rating": rating_0001_rating };
  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const capability = defineCapability({
    name: "rating",
    requiredBindings,
    config: RatingConfig,
    databases: {
      app: {
        binding: "DB",
        tables: ratingTables(),
        migrationOrder: RATING_MIGRATION_ORDER,
        migrations,
      },
    },
    routes: registerRatingRoutes({ games, config: resolved, basePath }),
    seeds: [ratingExampleSeed],
  });

  return Object.assign(capability, { ratingConfig: resolved, ratingGames: games });
}

export function isRatingCapability(c: Capability): c is RatingCapability {
  return c.name === "rating" && "ratingConfig" in c;
}
