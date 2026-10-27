// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { personRowsExport } from "@pithy-sh/core/src/capability/personRows";
import { type ErasingPurgeContribution, exportRows, purgeBinding } from "@pithy-sh/core/src/capability/purge";
import type { CompiledQuery } from "kysely";
import { RatingAdjustment } from "../data/adjustment";
import { outcomeLog } from "../data/log";
import { RatingOutcome, RatingOutcomePlayer } from "../data/outcome";
import { RatingRecord } from "../data/rating";
import {
  RATING_ADJUSTMENTS_TABLE,
  RATING_OUTCOME_PLAYERS_TABLE,
  RATING_OUTCOMES_TABLE,
  RATING_RATINGS_TABLE,
  type RatingDatabase,
  ratingDatabase,
} from "../data/tables";

/**
 * What erasing one person means for `@pithy-sh/rating` (#814): their rating in every pool — the skill, the
 * algorithm's state, experience and the count of games — the control-plane acts on it, and their place in the
 * outcome log (#818); and what exporting them hands back.
 *
 * **The rating is erased, not anonymized.** A rating is one person's number. Every opponent's own rating already
 * moved when the game was recorded and is kept in their own row, so deleting this one changes nobody else's.
 *
 * **So are the acts on it.** A row in `pithy_rating_adjustments` names the player and holds their rating before and
 * after, and it is the idempotency record of an act on a rating that no longer exists. The export leaves out the
 * idempotency key, which is the operator's, and the audit trail keeps the act with its actor.
 *
 * **The outcome log is anonymized, because an outcome is everyone's.** Each opponent's recalculation replays the
 * games they played against this person, handing the algorithm the state the log kept for every participant.
 * Deleting this person's rows would hand it a different roster, and every opponent's replay would land somewhere
 * live application never did. So the person's id is replaced by `erased-` and a random UUID — one per outcome, in
 * the participant row, the placements and the team grouping alike — so two erased players in one game stay two
 * players, and nothing joins the rows back to the account or to the person's other games. The state a stand-in
 * entered with stays: it is a number with nobody behind it, and the opponents' history is exact only with it.
 * A stand-in has no rating, and a void never gives it one.
 *
 * **Idempotent**: once replaced the id is in no row, so a second run finds nothing. The log is rewritten a page at
 * a time, each page one `d1.batch()`, and the rating and the acts go in a last batch of their own, so a retried step
 * finishes whatever the last one left.
 */

/** The one sentence the purge records with this step. */
export const RATING_PURGE_SUMMARY =
  "Deletes the user's rating, experience and games played in every pool and the acts on it, and anonymizes their place in every logged outcome so their opponents' ratings still replay.";

/** How many of the person's outcome rows one rewrite takes. */
const PAGE = 100;

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery) {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/** `record` with the key `userId` renamed to `standIn`, keeping its place and its value. */
function renamed<T>(record: Record<string, T>, userId: string, standIn: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key === userId ? standIn : key, value]));
}

/** One outcome with `userId` replaced by `standIn` in its placements and its team grouping. */
export function anonymizedOutcome(outcome: RatingOutcome, userId: string, standIn: string): RatingOutcome {
  return {
    ...outcome,
    ranks: renamed(outcome.ranks, userId, standIn),
    teams: outcome.teams === null ? null : renamed(outcome.teams, userId, standIn),
  };
}

/** The statements that anonymize one page of the person's outcome rows, or none once there are none left. */
async function anonymizePage(d1: D1Database, db: RatingDatabase, userId: string) {
  const page = await db
    .selectFrom(RATING_OUTCOME_PLAYERS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("id")
    .limit(PAGE)
    .execute();
  const entries = page.map((row) => RatingOutcomePlayer.parse(row));
  const outcomes = new Map(
    (await outcomeLog(db).outcomes(entries.map((entry) => entry.outcomeId))).map((outcome) => [outcome.id, outcome]),
  );
  return entries.flatMap((entry) => {
    const standIn = `erased-${crypto.randomUUID()}`;
    const statements = [
      prepared(
        d1,
        db.updateTable(RATING_OUTCOME_PLAYERS_TABLE).set({ userId: standIn }).where("id", "=", entry.id).compile(),
      ),
    ];
    const outcome = outcomes.get(entry.outcomeId);
    if (outcome) {
      const encoded = RatingOutcome.encode(anonymizedOutcome(outcome, userId, standIn));
      statements.push(
        prepared(
          d1,
          db
            .updateTable(RATING_OUTCOMES_TABLE)
            .set({ ranks: encoded.ranks, teams: encoded.teams } as never)
            .where("id", "=", outcome.id)
            .compile(),
        ),
      );
    }
    return statements;
  });
}

/** The user contribution `rating()` declares, over the D1 binding its tables live in. */
export function ratingUserPurge(database = "DB"): ErasingPurgeContribution {
  const rows = personRowsExport({
    capability: "rating",
    database,
    tables: [
      { table: RATING_RATINGS_TABLE, schema: RatingRecord, columns: ["userId"], as: "ratings", orderBy: "id" },
      {
        table: RATING_OUTCOME_PLAYERS_TABLE,
        schema: RatingOutcomePlayer,
        columns: ["userId"],
        as: "outcomePlayers",
        orderBy: "id",
      },
      {
        table: RATING_ADJUSTMENTS_TABLE,
        schema: RatingAdjustment,
        columns: ["userId"],
        as: "adjustments",
        orderBy: "id",
        omit: ["idempotencyKey"],
      },
    ],
  });
  const open = (env: Record<string, unknown>) => {
    const d1 = purgeBinding<D1Database>(env, database, "rating");
    return { d1, db: ratingDatabase(d1) };
  };
  return {
    subject: "user",
    summary: RATING_PURGE_SUMMARY,
    erase: async ({ subject, env }) => {
      const { d1, db } = open(env);
      for (;;) {
        const statements = await anonymizePage(d1, db, subject.id);
        if (statements.length === 0) break;
        await d1.batch(statements);
      }
      await d1.batch([
        prepared(d1, db.deleteFrom(RATING_ADJUSTMENTS_TABLE).where("userId", "=", subject.id).compile()),
        prepared(d1, db.deleteFrom(RATING_RATINGS_TABLE).where("userId", "=", subject.id).compile()),
      ]);
    },
    export: async (context) => {
      const exported = await rows(context);
      const { db } = open(context.env);
      const entries = (exported.outcomePlayers ?? []) as RatingOutcomePlayer[];
      const outcomes = await outcomeLog(db).outcomes(entries.map((entry) => entry.outcomeId));
      return {
        ratings: exported.ratings,
        outcomes: exportRows(outcomes),
        outcomePlayers: exported.outcomePlayers,
        adjustments: exported.adjustments,
      };
    },
  };
}
