// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { familyPrefix, type LeaderboardConfig, type ResolvedBoard, resolveBoard } from "../config/config";
import { LeaderboardBoardRecord } from "../data/boardRecord";
import { LEADERBOARD_BOARDS_TABLE, type LeaderboardDatabase } from "../data/tables";

/**
 * A family's instances, read from the board records.
 *
 * An instance exists once it has taken an entry: its first accepted submission records its definition, as
 * a configured board's does, and that record is never removed. So the records are the instance set, and a
 * family's instances are the records keyed `<prefix>/…` — a range on the unique `boardKey` index, from
 * just after `<prefix>/` to just before `<prefix>0`, the character after `/`.
 */

/** The `boardKey` range holding every instance of the family with this prefix. */
function instanceRange(prefix: string): { from: string; to: string } {
  return { from: `${prefix}/`, to: `${prefix}0` };
}

/** What {@link listInstances} accepts. */
export interface InstancesQuery {
  cursor?: string;
  limit?: number;
}

/**
 * One page of a family's instances, by key. Keyset on the key itself, so an instance created mid-walk
 * lands where it sorts and nothing is skipped or repeated. A cursor that is not one of ours is a first page.
 */
export async function listInstances(
  db: LeaderboardDatabase,
  prefix: string,
  query: InstancesQuery = {},
): Promise<{ items: LeaderboardBoardRecord[]; nextCursor: string | null }> {
  const limit = pageLimit(query.limit);
  const range = instanceRange(prefix);
  const decoded = decodeCursor(query.cursor);
  const after = typeof decoded?.sort === "string" && decoded.sort > range.from ? decoded.sort : range.from;
  const rows = await db
    .selectFrom(LEADERBOARD_BOARDS_TABLE)
    .selectAll()
    .where("boardKey", ">", after)
    .where("boardKey", "<", range.to)
    .orderBy("boardKey", "asc")
    // One more than asked for: how "is there another page" is answered without a COUNT.
    .limit(limit + 1)
    .execute();
  return toPage(
    rows.map((row) => LeaderboardBoardRecord.parse(row)),
    limit,
    (record) => ({ sort: record.boardKey, id: record.boardKey }),
  );
}

/**
 * How many instances one page of a rank pass walks.
 *
 * The instance set has no ceiling: without an `allow` hook, or with `serverAuthoritative` off, any caller
 * can mint instances. So no single unit of work may walk all of them. A rank Workflow run takes one page
 * and hands the rest to the next run, which keeps each run's steps (about two per instance, plus one per
 * stale window) and the page it persists far inside a Workflow instance's limits, however many instances
 * there are.
 */
export const INSTANCE_PAGE_SIZE = 100;

/** One page of {@link instancePage}: the instances to walk, and where the next page starts. */
export interface InstancePage {
  /** The page's instances, each resolved to its board, in key order. */
  boards: ResolvedBoard[];
  /** The last key this page read, to pass back as `after`; null when no instance follows it. */
  next: string | null;
}

/**
 * One page of every recorded instance of every configured family, in key order, resolved to its board —
 * what the rank pass and the retention sweep walk beside the configured boards. Keyset on the key, from
 * just after `after` (the start when null), so a walk visits each instance once and never holds more than
 * `limit` of them. A record whose key no longer fits its family resolves to nothing and is skipped; a
 * record of a family gone from config is never read.
 */
export async function instancePage(
  db: LeaderboardDatabase,
  config: LeaderboardConfig,
  after: string | null,
  limit: number = INSTANCE_PAGE_SIZE,
): Promise<InstancePage> {
  if (config.families.length === 0) return { boards: [], next: null };
  const ranges = config.families.map((family) => instanceRange(familyPrefix(family)));
  let query = db
    .selectFrom(LEADERBOARD_BOARDS_TABLE)
    .select("boardKey")
    .where((eb) =>
      eb.or(ranges.map((range) => eb.and([eb("boardKey", ">", range.from), eb("boardKey", "<", range.to)]))),
    );
  if (after !== null) query = query.where("boardKey", ">", after);
  // One more than asked for: how "is there another page" is answered without a COUNT.
  const rows = await query
    .orderBy("boardKey", "asc")
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const boards: ResolvedBoard[] = [];
  for (const { boardKey } of page) {
    const board = resolveBoard(config, boardKey);
    if (board?.family) boards.push(board);
  }
  return { boards, next: rows.length > limit ? (page.at(-1)?.boardKey ?? null) : null };
}
