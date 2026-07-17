import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { LeaderboardStore, ScoreAggregation, ScoreDirection } from "../config/config";

/**
 * The recorded definition of a board that has started taking entries — the row in
 * `pithy_leaderboard_boards`.
 *
 * Boards are config, not database rows, so this table holds no board *settings*. It holds only the three
 * fields that may never change once a score exists, so that changing one in `pithy.config.ts` fails loudly
 * instead of silently reinterpreting stored data:
 *
 *   - `direction` — flipping it turns every leader into a laggard.
 *   - `aggregation` — switching `best` to `sum` makes existing rows mean something they never meant.
 *   - `window` — a new schedule keys new scores into windows that do not line up with the stored ones.
 *
 * Every vendor surveyed treats these as create-time and immutable. Pithy cannot enforce that in the type
 * system because the board set is config the adopter edits freely, so it enforces it here, on first write
 * of each window, against what was actually recorded.
 */
export const LeaderboardBoardRecord = z
  .object({
    id: z.number().int().describe("Autoincrement primary key."),
    boardKey: z.string().describe("The board key this definition belongs to. Unique — one record per board."),
    store: LeaderboardStore.describe("The backing store recorded when this board took its first entry."),
    direction: ScoreDirection.describe("The direction recorded when this board took its first entry."),
    aggregation: ScoreAggregation.describe("The aggregation recorded when this board took its first entry."),
    window: z
      .string()
      .nullish()
      .describe("The window CRON recorded when this board took its first entry; null on an all-time board."),
    createdAt: SQLiteDate.describe("When this board first recorded an entry."),
  })
  .describe("The immutable fields of a board that has started recording entries — the drift guard.");
export type LeaderboardBoardRecord = z.output<typeof LeaderboardBoardRecord>;
export type LeaderboardBoardRecordRow = z.input<typeof LeaderboardBoardRecord>;
