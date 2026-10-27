// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type ErasingPurgeContribution, exportRows, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import { sql } from "kysely";
import { MultiplayerResult } from "../data/result";
import { MULTIPLAYER_RESULTS_TABLE, type MultiplayerDatabase, multiplayerDatabase } from "../data/tables";

/**
 * What erasing one person means for `@pithy-sh/multiplayer` (#814): every session result they played in is
 * **anonymized**, not erased — and exported first.
 *
 * **Anonymized, because the result is everyone's.** A result names every player, their scores and the winner; the
 * other players' history is in the same row. Deleting it would erase their game as well as this person's. So the
 * person's id is replaced, in the player list, the scores and the winner, by `erased-` and a random UUID — one per
 * row, so two erased players in one game stay two players, and nothing joins it back to the account or to the
 * person's other games.
 *
 * **Idempotent**: once replaced the id is in no row, so a second run finds nothing. A result is read by its players'
 * JSON, through SQLite's `json_each`, a page at a time.
 */

/** The one sentence the purge records with this step. */
export const MULTIPLAYER_PURGE_SUMMARY =
  "Anonymizes every session result the user played in — their id in the players, the scores and the winner is replaced — so the other players' results stay.";

/** How many results one read takes. */
const PAGE = 100;

/** The results `userId` played in, oldest first, at most `limit`. */
function played(db: MultiplayerDatabase, userId: string, limit?: number) {
  let query = db
    .selectFrom(MULTIPLAYER_RESULTS_TABLE)
    .selectAll()
    .where(sql<boolean>`exists (select 1 from json_each(players) where json_each.value = ${userId})`)
    .orderBy("createdAt")
    .orderBy("id");
  if (limit !== undefined) query = query.limit(limit);
  return query.execute();
}

/** One result with `userId` replaced by `stand-in` wherever it appears. */
export function anonymizedResult(result: MultiplayerResult, userId: string, standIn: string): MultiplayerResult {
  const swap = (id: string) => (id === userId ? standIn : id);
  return {
    ...result,
    players: result.players.map(swap),
    scores:
      result.scores === null
        ? null
        : Object.fromEntries(Object.entries(result.scores).map(([player, score]) => [swap(player), score])),
    winnerUserId: result.winnerUserId === null ? null : swap(result.winnerUserId),
  };
}

/** The user contribution `multiplayer()` declares, over the D1 binding the results live in. */
export function multiplayerUserPurge(database = "DB"): ErasingPurgeContribution {
  const open = (env: Record<string, unknown>) => {
    const d1 = purgeBinding<D1Database>(env, database, "multiplayer");
    return { d1, db: multiplayerDatabase(d1) };
  };
  return {
    subject: "user",
    summary: MULTIPLAYER_PURGE_SUMMARY,
    erase: async ({ subject, env }) => {
      const { d1, db } = open(env);
      for (;;) {
        const page = await played(db, subject.id, PAGE);
        if (page.length === 0) return;
        const statements = page.map((row) => {
          const result = anonymizedResult(MultiplayerResult.parse(row), subject.id, `erased-${crypto.randomUUID()}`);
          const encoded = MultiplayerResult.encode(result);
          const compiled = db
            .updateTable(MULTIPLAYER_RESULTS_TABLE)
            .set({ players: encoded.players, scores: encoded.scores, winnerUserId: encoded.winnerUserId })
            .where("id", "=", result.id)
            .compile();
          return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
        });
        await d1.batch(statements);
      }
    },
    export: async ({ subject, env }) => {
      const rows = await played(open(env).db, subject.id);
      return { results: exportRows(rows.map((row) => MultiplayerResult.parse(row))) };
    },
  };
}
