// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { RatingRecord } from "./rating";

/**
 * The rating capability's tables. One table today — `pithy_rating_ratings` — holding both numbers per
 * player per pool. Table names are camelCase constants; core's `createDatabase` installs the mandatory
 * `CamelCasePlugin`, so query code never types the snake_case `pithy_rating_*` columns.
 */

export const RATING_RATINGS_TABLE = "pithyRatingRatings";

export function ratingTables(): Record<string, z.ZodObject> {
  return { [RATING_RATINGS_TABLE]: RatingRecord };
}

type RatingTables = { [RATING_RATINGS_TABLE]: typeof RatingRecord };
export type RatingDatabase = Kysely<DatabaseSchema<RatingTables>>;

export function ratingDatabase(d1: D1Database): RatingDatabase {
  return createDatabase(d1, { [RATING_RATINGS_TABLE]: RatingRecord }) as unknown as RatingDatabase;
}
