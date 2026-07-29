import { assertBoardDefinition } from "../board/registry";
import type { LeaderboardBoard, LeaderboardConfig } from "../config/config";
import type { LeaderboardDatabase } from "../data/tables";
import { entryStore } from "../entry/store";
import {
  LeaderboardBoardNotFoundError,
  LeaderboardEntryNotFoundError,
  LeaderboardScoreRejectedError,
} from "../error/errors";
import { entriesAround, type RankedEntry, rankOf, topEntries } from "../rank/query";
import { windowKeyAt } from "../window/schedule";
import type { HideBody, SegmentBody, SubmitScoreBody, VisibilityBody } from "./schemas";

/**
 * The leaderboard handlers — pure functions over injected deps. Nothing here touches a Hono `Context`;
 * the routes unwrap the request and hand the pieces down, which is what makes every case below testable
 * without a request at all. Nothing here parses, either: the route line declares each shape with
 * `zValidator`, so a handler receives values that are already the type it names.
 */
export interface HandlerDeps {
  config: LeaderboardConfig;
  db: LeaderboardDatabase;
  /** The authenticated player, from the core AuthContext seam. Never from the request body. */
  userId: string;
  now: () => Date;
}

/** The configured board, or a 404. Board keys come from config, so an unknown key is not a lookup miss. */
function board(deps: HandlerDeps, key: string): LeaderboardBoard {
  const found = deps.config.boards.find((b) => b.key === key);
  if (!found) throw new LeaderboardBoardNotFoundError({ detail: `No board configured with key "${key}".` });
  return found;
}

/**
 * Which window a read applies to: the one the client named, or the one open now.
 *
 * A named window is not validated against the schedule. A key that never was a window simply selects no
 * entries, and letting a client read a closed window by key is the feature — that history is in the
 * adopter's own D1, retained on their terms.
 */
function readWindow(deps: HandlerDeps, b: LeaderboardBoard, requested: string | undefined): string {
  return requested ?? windowKeyAt(b.window, deps.now());
}

export interface BoardPage {
  board: string;
  window: string;
  entries: RankedEntry[];
}

export async function submitScore(
  deps: HandlerDeps,
  boardKey: string,
  body: SubmitScoreBody,
): Promise<{ window: string }> {
  const b = board(deps, boardKey);
  const { score } = body;
  // Server-side bounds are the whole demonstrated anti-cheat baseline. Checked before anything is
  // written, so a rejected score leaves no trace on the board.
  if (b.min !== undefined && score < b.min) {
    throw new LeaderboardScoreRejectedError({ detail: `Score ${score} is below board "${b.key}" min ${b.min}.` });
  }
  if (b.max !== undefined && score > b.max) {
    throw new LeaderboardScoreRejectedError({ detail: `Score ${score} is above board "${b.key}" max ${b.max}.` });
  }
  const now = deps.now();
  // Guard the board's immutable fields before the first write of each board, not after.
  await assertBoardDefinition(deps.db, b, now);
  const window = windowKeyAt(b.window, now);
  await entryStore(deps.db).submit(b, window, deps.userId, score, now, deps.config.visibleByDefault);
  return { window };
}

export async function readTop(
  deps: HandlerDeps,
  boardKey: string,
  query: { window?: string; limit: number; offset: number },
): Promise<BoardPage> {
  const b = board(deps, boardKey);
  const window = readWindow(deps, b, query.window);
  return { board: b.key, window, entries: await topEntries(deps.db, b, window, query.limit, query.offset) };
}

export async function readSegment(deps: HandlerDeps, boardKey: string, body: SegmentBody): Promise<BoardPage> {
  const b = board(deps, boardKey);
  const { userIds, limit, offset, window: requested } = body;
  const window = readWindow(deps, b, requested);
  return {
    board: b.key,
    window,
    entries: await topEntries(deps.db, b, window, limit, offset, { segment: userIds }),
  };
}

export interface OwnRank {
  board: string;
  window: string;
  userId: string;
  score: number;
  rank: number | null;
  tier: string | null;
  visible: boolean;
  /** True when `rank` came from the stored column and may lag the score beside it. */
  rankStale: boolean;
}

export async function readOwnRank(deps: HandlerDeps, boardKey: string, query: { window?: string }): Promise<OwnRank> {
  const b = board(deps, boardKey);
  const window = readWindow(deps, b, query.window);
  const materialized = typeof deps.config.rank === "object";
  const own = await rankOf(deps.db, b, window, deps.userId, materialized);
  if (!own) {
    throw new LeaderboardEntryNotFoundError({
      detail: `User ${deps.userId} has no entry on board "${b.key}" in window ${window}.`,
    });
  }
  return {
    board: b.key,
    window,
    userId: deps.userId,
    score: own.entry.score,
    rank: own.rank,
    tier: own.tier,
    visible: own.entry.visible,
    rankStale: materialized,
  };
}

export async function readAround(
  deps: HandlerDeps,
  boardKey: string,
  query: { window?: string; radius: number },
): Promise<BoardPage> {
  const b = board(deps, boardKey);
  const window = readWindow(deps, b, query.window);
  return { board: b.key, window, entries: await entriesAround(deps.db, b, window, deps.userId, query.radius) };
}

export async function setOwnVisibility(
  deps: HandlerDeps,
  boardKey: string,
  query: { window?: string },
  body: VisibilityBody,
): Promise<{ visible: boolean }> {
  const b = board(deps, boardKey);
  const { visible } = body;
  const window = readWindow(deps, b, query.window);
  const updated = await entryStore(deps.db).setVisibility(b.key, window, deps.userId, visible);
  if (!updated) {
    throw new LeaderboardEntryNotFoundError({
      detail: `User ${deps.userId} has no entry on board "${b.key}" in window ${window} to make ${visible ? "visible" : "hidden"}.`,
    });
  }
  return { visible };
}

export async function hideEntry(
  deps: HandlerDeps,
  boardKey: string,
  targetUserId: string,
  query: { window?: string },
  body: HideBody,
): Promise<{ hidden: boolean }> {
  const b = board(deps, boardKey);
  const { hidden } = body;
  const window = readWindow(deps, b, query.window);
  const updated = await entryStore(deps.db).hide(b.key, window, targetUserId, hidden);
  if (!updated) {
    throw new LeaderboardEntryNotFoundError({
      message: "That entry does not exist.",
      detail: `No entry for user ${targetUserId} on board "${b.key}" in window ${window}.`,
    });
  }
  return { hidden };
}

export async function removeEntry(
  deps: HandlerDeps,
  boardKey: string,
  targetUserId: string,
  query: { window?: string },
): Promise<{ removed: boolean }> {
  const b = board(deps, boardKey);
  const window = readWindow(deps, b, query.window);
  const removed = await entryStore(deps.db).remove(b.key, window, targetUserId);
  if (!removed) {
    throw new LeaderboardEntryNotFoundError({
      message: "That entry does not exist.",
      detail: `No entry for user ${targetUserId} on board "${b.key}" in window ${window}.`,
    });
  }
  return { removed };
}

/** The board set, as configured — what a client needs to render a board picker. */
export function listBoards(deps: HandlerDeps): {
  boards: Array<{
    key: string;
    store: string;
    direction: string;
    aggregation: string;
    window: string | null;
    tiers: Array<{ key: string; from: number }>;
  }>;
} {
  return {
    boards: deps.config.boards.map((b) => ({
      key: b.key,
      // Always `d1` today; surfaced so a client can tell an exact board from a future approximate one.
      store: b.store,
      direction: b.direction,
      aggregation: b.aggregation,
      window: b.window ?? null,
      tiers: b.tiers?.map((t) => ({ key: t.key, from: t.from })) ?? [],
    })),
  };
}
