// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { RatingAdjustment } from "./adjustment";
import { RatingOutcome, RatingOutcomePlayer } from "./outcome";
import { RatingRecord } from "./rating";

/**
 * The rating capability's tables. `pithy_rating_ratings` holds both numbers per player per pool; the
 * outcome log (`pithy_rating_outcomes`, `pithy_rating_outcome_players`) holds how they got there; and
 * `pithy_rating_adjustments` holds what the control plane did to them. Table names are camelCase
 * constants; core's `createDatabase` installs the mandatory `CamelCasePlugin`, so query code never types
 * the snake_case `pithy_rating_*` columns.
 */

export const RATING_RATINGS_TABLE = "pithyRatingRatings";
export const RATING_OUTCOMES_TABLE = "pithyRatingOutcomes";
export const RATING_OUTCOME_PLAYERS_TABLE = "pithyRatingOutcomePlayers";
export const RATING_ADJUSTMENTS_TABLE = "pithyRatingAdjustments";

const TABLES = {
  [RATING_RATINGS_TABLE]: RatingRecord,
  [RATING_OUTCOMES_TABLE]: RatingOutcome,
  [RATING_OUTCOME_PLAYERS_TABLE]: RatingOutcomePlayer,
  [RATING_ADJUSTMENTS_TABLE]: RatingAdjustment,
} as const;

export function ratingTables(): Record<string, z.ZodObject> {
  return { ...TABLES };
}

type RatingTables = typeof TABLES;
export type RatingDatabase = Kysely<DatabaseSchema<RatingTables>>;

/**
 * The D1 binding behind each database `ratingDatabase` built — what lets a store run several statements as
 * one `DB.batch`, which D1 runs as a transaction. Kysely has no transaction over D1, and threading the
 * binding through every signature beside the database would change the peer surface `matchmaking` reads.
 * Weak, so a database dropped by its request takes its entry with it.
 */
const bindings = new WeakMap<RatingDatabase, D1Database>();

export function ratingDatabase(d1: D1Database): RatingDatabase {
  const db = createDatabase(d1, TABLES) as unknown as RatingDatabase;
  bindings.set(db, d1);
  return db;
}

/** The D1 binding a database from {@link ratingDatabase} runs on, or undefined for one built elsewhere. */
export function ratingBinding(db: RatingDatabase): D1Database | undefined {
  return bindings.get(db);
}
