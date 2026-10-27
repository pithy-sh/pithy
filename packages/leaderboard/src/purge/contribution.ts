// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { personRowsPurge } from "@pithy-sh/core/src/capability/personRows";
import { type ErasingPurgeContribution, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import type { CompiledQuery } from "kysely";
import { LeaderboardContribution } from "../data/contribution";
import { LeaderboardEntry } from "../data/entry";
import { LeaderboardModeration } from "../data/moderation";
import {
  LEADERBOARD_CONTRIBUTIONS_TABLE,
  LEADERBOARD_ENTRIES_TABLE,
  LEADERBOARD_MODERATIONS_TABLE,
  leaderboardDatabase,
} from "../data/tables";
import { markStale } from "../rank/stale";

/**
 * What erasing one person means for `@pithy-sh/leaderboard` (#814): their entry on every board in every window —
 * the score, when it was achieved, their consent to appear and any moderator's hide — what each session result put
 * on those entries, and the moderation history of them; and what exporting them hands back.
 *
 * **Erased, not anonymized.** A board is a ranking of people, and an entry nobody owns is a rank nobody holds. The
 * rank worker renumbers the open window on every pass, but a closed window only once something marks it stale. So,
 * like a void or a moderator's act, the purge marks every window in which it deletes a ranked entry, in the same
 * batch as the deletes, and the next pass closes the gap there too.
 *
 * **A result's contribution goes with the entry.** It is what lets a void take one session's points back off an
 * entry, and with the entry gone there is nothing to take them back from.
 *
 * **So does the entry's moderation history.** A row names the player whose entry was hidden or corrected and holds
 * their score before and after, so it is their data, and it is the idempotency record of an act on an entry that no
 * longer exists. A replay of that act after the purge finds no entry to act on. Who took the act is the operator's,
 * not the person's: the export leaves out the operator's subject, their connection and their idempotency key, and the
 * audit trail keeps the act with its actor. A `clear_lock` names no player and stays.
 */

/** The one sentence the purge records with this step. */
export const LEADERBOARD_PURGE_SUMMARY =
  "Deletes the user's entries on every board, in every window, what each session result put on them, and their moderation history.";

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery) {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/** The user contribution `leaderboard()` declares, over the D1 binding its tables live in. */
export function leaderboardUserPurge(database = "DB"): ErasingPurgeContribution {
  const rows = personRowsPurge({
    capability: "leaderboard",
    summary: LEADERBOARD_PURGE_SUMMARY,
    database,
    tables: [
      {
        table: LEADERBOARD_CONTRIBUTIONS_TABLE,
        schema: LeaderboardContribution,
        columns: ["userId"],
        as: "contributions",
        orderBy: "id",
      },
      {
        table: LEADERBOARD_MODERATIONS_TABLE,
        schema: LeaderboardModeration,
        columns: ["userId"],
        as: "moderations",
        orderBy: "id",
        omit: ["idempotencyKey", "connectionId", "actorId"],
      },
      { table: LEADERBOARD_ENTRIES_TABLE, schema: LeaderboardEntry, columns: ["userId"], as: "entries", orderBy: "id" },
    ],
  });
  return {
    ...rows,
    erase: async ({ subject, env }) => {
      const d1 = purgeBinding<D1Database>(env, database, "leaderboard");
      const db = leaderboardDatabase(d1);
      // The windows a ranked entry of theirs sits in: each has a stored rank below theirs that moves up one.
      const ranked = await db
        .selectFrom(LEADERBOARD_ENTRIES_TABLE)
        .select(["boardId", "windowKey"])
        .distinct()
        .where("userId", "=", subject.id)
        .where("rank", "is not", null)
        .execute();
      const now = new Date();
      await d1.batch([
        prepared(d1, db.deleteFrom(LEADERBOARD_CONTRIBUTIONS_TABLE).where("userId", "=", subject.id).compile()),
        prepared(d1, db.deleteFrom(LEADERBOARD_MODERATIONS_TABLE).where("userId", "=", subject.id).compile()),
        prepared(d1, db.deleteFrom(LEADERBOARD_ENTRIES_TABLE).where("userId", "=", subject.id).compile()),
        ...ranked.map(({ boardId, windowKey }) => prepared(d1, markStale(db, boardId, windowKey, now))),
      ]);
    },
  };
}
