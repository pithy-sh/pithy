// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ratingStore } from "./data/store";
import { ratingDatabase } from "./data/tables";

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

/** Rating's peer surface, by type — what `ratingPeer` holds. */
export type RatingPeer = typeof ratingPeer;
