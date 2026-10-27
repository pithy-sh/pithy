// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { ResolvedRatingGame } from "./config/config";
import { ratingStore } from "./data/store";
import { ratingDatabase } from "./data/tables";
import { type RatingVoidResult, voidResult } from "./history/void";

/**
 * **What a capability composed beside rating may read — handed to it, never imported by it** (#645).
 *
 * `@pithy-sh/rating` is an optional peer of `matchmaking`, which buckets a queue by skill when there is a skill
 * to read. It used to reach these modules by `import()` behind a `try`, and a literal specifier is one a
 * bundler resolves whether or not the branch holding it ever runs — so a project without rating could not
 * bundle matchmaking at all.
 *
 * So `rating()` carries this object as `ratingPeer`, and a dependent finds it among the composed capabilities
 * in its `compose` hook. The dependent names this package only in a type, which a bundler never sees.
 */
export const ratingPeer = { ratingStore, ratingDatabase } as const;

/**
 * Rating's peer surface, by type — what `rating()` hands a capability composed beside it.
 *
 * `voidResult` is the void consumer (#818): a void cascade (#820) calls it with a result id, and every outcome
 * recorded with that id is marked void and every player it touched is recalculated from the outcomes that
 * remain. It reports each player before and after, in the shape `RatingVoidReport` in `http/responses.ts`
 * declares. It is bound to the configured games, which is why it is built per capability rather than
 * carried on the constant above.
 */
export type RatingPeer = typeof ratingPeer & {
  /** Void every outcome recorded with `resultId`, and recalculate every player it touched. Idempotent. */
  voidResult(d1: D1Database, resultId: string, now?: Date): Promise<RatingVoidResult>;
};

/** The peer surface for one capability's configured games. */
export function ratingPeerFor(games: readonly ResolvedRatingGame[]): RatingPeer {
  return {
    ...ratingPeer,
    voidResult: (d1, resultId, now = new Date()) => voidResult(ratingDatabase(d1), games, resultId, now),
  };
}
