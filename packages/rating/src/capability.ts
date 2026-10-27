// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import "./algorithm/builtins";
import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { scopeGatesOf } from "@pithy-sh/core/src/http/scopeGates";
import type { Migration } from "kysely/migration";
import { RatingConfig, type RatingConfigInput, type ResolvedRatingGame, validateRatingGames } from "./config/config";
import { ratingTables } from "./data/tables";
import { registerRatingRoutes } from "./http/routes";
import { ratingAdminRoutes } from "./http/scopes";
import { rating_0001_rating } from "./migrations/0001_rating";
import { rating_0002_outcome_log } from "./migrations/0002_outcome_log";
import { type RatingPeer, ratingPeerFor } from "./peer";
import { ratingUserPurge } from "./purge/contribution";
import { ratingExampleSeed } from "./seeds/example";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.generated";

/**
 * Where rating's migrations sort in the app database. Unique per database; the registry composes keys like
 * `0600_rating_0001_rating`. Sits after multiplayer (500).
 */
export const RATING_MIGRATION_ORDER = 600;

/** Where rating mounts when no `basePath` is given. */
export const RATING_DEFAULT_BASE_PATH = "/rating";

export type RatingOptions = RatingConfigInput & {
  /** Mount the routes somewhere other than `/rating`. */
  basePath?: string;
};

export interface RatingCapability extends Capability {
  ratingConfig: RatingConfig;
  ratingGames: ResolvedRatingGame[];
  /**
   * What a capability composed beside this one reaches rating through — `matchmaking` reading skill to bucket
   * a queue, and a void cascade taking a result back out of the ratings (#818). Found in a `compose` hook, so
   * nothing imports this package and a project without rating bundles it (#645). See `peer.ts`.
   */
  ratingPeer: RatingPeer;
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

  // Resolved once and handed to both the router and the manifest, so the advertised admin paths and the
  // mounted ones cannot disagree about the default.
  const mountPath = basePath ?? RATING_DEFAULT_BASE_PATH;

  const migrations: Record<string, Migration> = {
    "0001_rating": rating_0001_rating,
    "0002_outcome_log": rating_0002_outcome_log,
  };
  const requiredBindings: BindingSpecInput[] = [{ type: "d1", name: "DB" }];

  const routes = registerRatingRoutes({ games, config: resolved, basePath: mountPath });
  const capability = defineCapability({
    name: "rating",
    // The package this capability ships in and the version it ships at, both stamped by
    // `scripts/stampVersions.ts` — a Worker cannot read its own package.json. Reported per capability by
    // the control-plane manifest, and reported together: a release feed is keyed by package name, so the
    // version alone leaves a client guessing the key (#626).
    version: PACKAGE_VERSION,
    package: PACKAGE_NAME,
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
    routes,
    // Read off the routes above rather than listed beside them, so `pithy doctor` names exactly the gates
    // this config mounted — a gate the config switched off is not here (#560).
    scopeGates: scopeGatesOf(routes),
    // The management surface, built from the resolved mount path: always declared and always mounted, and
    // with `controlplane()` uncomposed each route denies with `controlplane/not_connected` (#818).
    adminRoutes: ratingAdminRoutes(mountPath),
    seeds: [ratingExampleSeed],
    // A person's ratings: exported on an access request and erased by their purge, as its own step in the adopter's
    // Worker (#814).
    purge: [ratingUserPurge()],
  });

  return Object.assign(capability, { ratingConfig: resolved, ratingGames: games, ratingPeer: ratingPeerFor(games) });
}

export function isRatingCapability(c: Capability): c is RatingCapability {
  return c.name === "rating" && "ratingConfig" in c;
}
