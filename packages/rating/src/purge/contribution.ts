// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { personRowsPurge } from "@pithy-sh/core/src/capability/personRows";
import type { ErasingPurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { RatingRecord } from "../data/rating";
import { RATING_RATINGS_TABLE } from "../data/tables";

/**
 * What erasing one person means for `@pithy-sh/rating` (#814): their rating in every pool — the skill, the
 * algorithm's state, experience and the count of games — and what exporting them hands back.
 *
 * **Erased, not anonymized.** A rating is one person's number. Every opponent's own rating already moved when the
 * game was recorded and is kept in their own row, so deleting this one changes nobody else's.
 */

/** The one sentence the purge records with this step. */
export const RATING_PURGE_SUMMARY = "Deletes the user's rating, experience and games played in every pool.";

/** The user contribution `rating()` declares, over the D1 binding its tables live in. */
export function ratingUserPurge(database = "DB"): ErasingPurgeContribution {
  return personRowsPurge({
    capability: "rating",
    summary: RATING_PURGE_SUMMARY,
    database,
    tables: [{ table: RATING_RATINGS_TABLE, schema: RatingRecord, columns: ["userId"], as: "ratings", orderBy: "id" }],
  });
}
