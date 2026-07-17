import type { LeaderboardBoard } from "../config/config";
import { LeaderboardBoardRecord } from "../data/boardRecord";
import { LEADERBOARD_BOARDS_TABLE, type LeaderboardDatabase } from "../data/tables";
import { LeaderboardBoardImmutableError } from "../error/errors";

/**
 * The board drift guard.
 *
 * `store`, `direction`, `aggregation`, and `window` are create-time and immutable on every vendor
 * surveyed, and for good reason: each one is the lens through which stored scores are read, so changing
 * one reinterprets data rather than reconfiguring behaviour. Flip `direction` and last place becomes
 * first. Switch `best` to `sum` and the number in the column stops meaning what it meant. Change `window`
 * and new scores key into windows that do not line up with the stored ones. Move a board to a different
 * `store` and its scores live in a different place entirely.
 *
 * Pithy cannot enforce that in the type system, because a board is config the adopter edits freely and
 * redeploys. So the first entry on a board records those fields, and every later write checks against the
 * record. The failure is loud and immediate instead of a silently corrupted board.
 *
 * This is the answer to the issue's open question: a board definition is *not* migratable. There is no
 * `pithy migrate` story for a board, because there is no safe automatic reinterpretation of the scores
 * already stored. Changing one of these fields means a new board key.
 */
export async function assertBoardDefinition(
  db: LeaderboardDatabase,
  board: LeaderboardBoard,
  now: Date,
): Promise<void> {
  let recorded = await db
    .selectFrom(LEADERBOARD_BOARDS_TABLE)
    .selectAll()
    .where("boardKey", "=", board.key)
    .executeTakeFirst();

  if (!recorded) {
    const row = LeaderboardBoardRecord.encode({
      id: 0,
      boardKey: board.key,
      store: board.store,
      direction: board.direction,
      aggregation: board.aggregation,
      window: board.window ?? null,
      createdAt: now,
    }) as Record<string, unknown>;
    delete row.id;
    // `OR IGNORE`, not a plain insert: two first-ever submissions can race here, and losing that race is
    // not an error on its own — but the winner may have recorded a *different* definition (a config
    // change to an immutable field landed between the two requests, mid-deploy). So we do not return on
    // the insert; we re-read the row that actually won and fall through to the drift check below. That
    // closes the window where a divergent first submission would otherwise skip the guard entirely.
    await db
      .insertInto(LEADERBOARD_BOARDS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side.
      .values(row as any)
      .onConflict((oc) => oc.column("boardKey").doNothing())
      .execute();
    recorded = await db
      .selectFrom(LEADERBOARD_BOARDS_TABLE)
      .selectAll()
      .where("boardKey", "=", board.key)
      .executeTakeFirst();
    if (!recorded) {
      // The row we just inserted-or-ignored is gone — only possible if retention or an admin deleted the
      // whole board between the insert and this read. Treat it as transient rather than corrupting data.
      throw new LeaderboardBoardImmutableError({
        message: "That board's definition could not be confirmed. Retry.",
        detail: `Board "${board.key}" record vanished immediately after insert; a concurrent delete is the likely cause.`,
      });
    }
  }

  const previous = LeaderboardBoardRecord.parse(recorded);
  const drifted: string[] = [];
  if (previous.store !== board.store) {
    drifted.push(`store ${previous.store} → ${board.store}`);
  }
  if (previous.direction !== board.direction) {
    drifted.push(`direction ${previous.direction} → ${board.direction}`);
  }
  if (previous.aggregation !== board.aggregation) {
    drifted.push(`aggregation ${previous.aggregation} → ${board.aggregation}`);
  }
  if ((previous.window ?? null) !== (board.window ?? null)) {
    drifted.push(`window ${previous.window ?? "all-time"} → ${board.window ?? "all-time"}`);
  }
  if (drifted.length > 0) {
    throw new LeaderboardBoardImmutableError({
      detail: `Board "${board.key}" changed after recording entries: ${drifted.join(", ")}.`,
    });
  }
}
