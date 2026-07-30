// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One player's standing in one rating pool — the row in `pithy_rating_ratings`. It carries the tracker's
 * **two distinct numbers**: `skill` (the MMR the matchmaker buckets on, up and down, opponent-weighted)
 * and `xp` (the monotonic experience total that only ever rises). The algorithm-specific `state` blob is
 * the source of `skill`; it is stored opaque here and validated against the resolving algorithm's own
 * `state` schema on read (defense in depth — this table cannot know which algorithm owns a pool).
 */
export const RatingRecord = z
  .object({
    id: z.number().int().describe("Autoincrement PK. Internal only."),
    pool: z.string().describe("The rating pool this row belongs to. A pool is rated by a single algorithm."),
    userId: z
      .string()
      .describe("The player's authenticated user id (`pithy_auth_users.id`), never a client-supplied id."),
    algorithm: z
      .string()
      .describe("The algorithm id that produced `state` — recorded so a read validates the blob correctly."),
    state: sqliteJson(z.unknown()).describe(
      "The algorithm's per-player rating state (Elo `{rating}`, Glicko-2 `{rating,rd,vol}`, TrueSkill `{mu,sigma}`), stored as JSON and re-validated by the algorithm on read.",
    ),
    skill: z
      .number()
      .describe(
        "The conservative comparable skill number (`algorithm.skill(state)`), denormalized so matchmaking buckets and reads never re-derive it.",
      ),
    xp: z.number().describe("The player's monotonic experience total in this pool — only ever rises."),
    games: z.number().int().describe("How many rated games this player has completed in this pool."),
    updatedAt: SQLiteDate.describe("When this row last changed."),
  })
  .describe("One player's rating and experience in one pool.");

export type RatingRecord = z.output<typeof RatingRecord>;
export type RatingRecordRow = z.input<typeof RatingRecord>;
