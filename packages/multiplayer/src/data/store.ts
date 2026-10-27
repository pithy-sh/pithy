// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { type CompiledQuery, type Expression, type ExpressionBuilder, type Kysely, type SqlBool, sql } from "kysely";
import { MultiplayerResult, type NewMultiplayerResult, type VoidConsumerStatus } from "./result";
import {
  MULTIPLAYER_RESULTS_TABLE,
  MULTIPLAYER_VOID_KEYS_TABLE,
  type MultiplayerDatabase,
  multiplayerDatabase,
} from "./tables";
import { MultiplayerVoidKey } from "./voidKey";

/** What a page of results is asked for with. */
export interface ResultQuery {
  /** Restrict to one game. Already resolved against config by the handler. */
  gameKey?: string;
  /** `true` for voided results only, `false` for those that count, absent for both. */
  voided?: boolean;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** One page of results, most recently ended first, and where the next one resumes. */
export interface ResultPage {
  items: MultiplayerResult[];
  nextCursor: string | null;
}

/**
 * Reads and writes over `pithy_multiplayer_results`.
 *
 * Round-trip rule (CLAUDE.md §Data layer): read with `MultiplayerResult.parse` (decode), write with
 * `MultiplayerResult.encode` (encode). No raw `0/1`, epoch, or `JSON.stringify` below.
 *
 * **Every key spent on a void is kept** in `pithy_multiplayer_void_keys`, one row each and unique. A result's own
 * `voidKey` is only the key holding its void now, the one a retry's claim is conditional on; a key it moved past
 * is still spent, so it still replays and still cannot void another result. A key is spent in the same D1 batch,
 * one transaction, as the write it was sent for — never one without the other.
 */
export interface ResultStore {
  /**
   * Persist a terminal session's result. Idempotent on `sessionId`: an at-least-once alarm retry or a
   * double-resolve writes the row once and no more, so a session can never record two conflicting results.
   */
  write(result: NewMultiplayerResult): Promise<void>;
  /** The result for a session, or undefined if it has not reached a terminal state. */
  get(sessionId: string): Promise<MultiplayerResult | undefined>;
  /** Results, most recently ended first, a keyset page at a time. */
  list(query: ResultQuery): Promise<ResultPage>;
  /** The result a void key was spent on — by the void, or by any retry of it — or undefined when it never was. */
  byVoidKey(voidKey: string): Promise<MultiplayerResult | undefined>;
  /** When a void key was spent, or undefined when it never was. */
  spentAt(voidKey: string): Promise<Date | undefined>;
  /**
   * Mark a result void under `voidKey`, with each consumer's starting status. Conditional on the result still
   * counting, so of two voids racing on one result exactly one marks it: true when this call did, false when the
   * result was void already, and spends the key only when it marks. A key already spent fails on the unique index;
   * see {@link isUniqueViolation}.
   */
  markVoided(sessionId: string, voidKey: string, consumers: VoidConsumerStatus[], at: Date): Promise<boolean>;
  /**
   * Hand a voided result's void to a new key, for a retry of its unfinished consumers, and record `consumers` —
   * the ones it is about to run set `pending` — in the same write, so the retry holds them under its lease as the
   * first void held its own. Conditional on the key it still holds, so of two retries racing from one key exactly
   * one claims it: true when this call did. The key it held stays spent, and `toKey` is spent only when this call
   * claims. A key already spent — on another result, or on this one — fails on the unique index.
   */
  claimRetry(
    sessionId: string,
    fromKey: string | null,
    toKey: string,
    at: Date,
    consumers: VoidConsumerStatus[],
  ): Promise<boolean>;
  /** Record what each consumer of a void did. */
  recordConsumers(sessionId: string, consumers: VoidConsumerStatus[]): Promise<void>;
}

/** The encoded form of a consumer list, through the column's own codec. */
function encodedConsumers(consumers: VoidConsumerStatus[]): string {
  return MultiplayerResult.shape.voidConsumers.encode(consumers) as string;
}

/** The encoded form of the moment a key was spent, through the column's own codec. */
function encodedSpentAt(at: Date): number {
  return MultiplayerVoidKey.shape.spentAt.encode(at) as number;
}

/** A condition on one result row, usable on its select and on its update alike. */
type ResultCondition = (
  eb: ExpressionBuilder<
    MultiplayerDatabase extends Kysely<infer Schema> ? Schema : never,
    typeof MULTIPLAYER_RESULTS_TABLE
  >,
) => Expression<SqlBool>;

/** Results and the keys spent on them, over the `DB` binding a batch needs. */
export function resultStore(d1: D1Database): ResultStore {
  const db = multiplayerDatabase(d1);
  /** Compile a Kysely query to a D1 prepared statement, so it can join a `DB.batch` transaction. */
  const prepared = (query: { compile(): CompiledQuery }): D1PreparedStatement => {
    const compiled = query.compile();
    return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
  };
  /**
   * Spend `voidKey` on `sessionId`'s result, if the result matches `where` — inserted from a select over the result,
   * so the key is spent exactly when the write beside it in the batch applies.
   */
  const spend = (sessionId: string, voidKey: string, at: Date, condition: ResultCondition) =>
    db
      .insertInto(MULTIPLAYER_VOID_KEYS_TABLE)
      .columns(["voidKey", "sessionId", "spentAt"])
      .expression(
        db
          .selectFrom(MULTIPLAYER_RESULTS_TABLE)
          .where("sessionId", "=", sessionId)
          .where(condition)
          .select([
            sql<string>`${voidKey}`.as("voidKey"),
            sql<string>`${sessionId}`.as("sessionId"),
            sql<number>`${encodedSpentAt(at)}`.as("spentAt"),
          ]),
      );
  /** Whether the batch's first statement — the key's insert — wrote a row. */
  const spent = (results: { meta: { changes?: number } }[]) => Number(results[0]?.meta.changes ?? 0) > 0;

  const get = async (sessionId: string): Promise<MultiplayerResult | undefined> => {
    const row = await db
      .selectFrom(MULTIPLAYER_RESULTS_TABLE)
      .selectAll()
      .where("sessionId", "=", sessionId)
      .executeTakeFirst();
    return row ? MultiplayerResult.parse(row) : undefined;
  };

  return {
    async write(result) {
      const row = MultiplayerResult.encode({
        ...result,
        id: 0,
        voidedAt: null,
        voidKey: null,
        voidConsumers: null,
      }) as Record<string, unknown>;
      // `id` is a rowid alias — let SQLite assign it rather than inserting the placeholder above.
      delete row.id;
      await db
        .insertInto(MULTIPLAYER_RESULTS_TABLE)
        // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side; Kysely's insert type is derived from it.
        .values(row as any)
        // A terminal session writes its result exactly once; a retry must be a no-op, not a duplicate or an error.
        .onConflict((oc) => oc.column("sessionId").doNothing())
        .execute();
    },

    get,

    async list(query) {
      const limit = pageLimit(query.limit);
      const after = decodeCursor(query.cursor);
      let selection = db
        .selectFrom(MULTIPLAYER_RESULTS_TABLE)
        .selectAll()
        .orderBy("resolvedAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (query.gameKey !== undefined) selection = selection.where("gameKey", "=", query.gameKey);
      if (query.voided === true) selection = selection.where("voidedAt", "is not", null);
      if (query.voided === false) selection = selection.where("voidedAt", "is", null);
      if (after !== undefined && typeof after.sort === "number" && typeof after.id === "number") {
        const { sort, id } = after;
        selection = selection.where((eb) =>
          eb.or([eb("resolvedAt", "<", sort), eb.and([eb("resolvedAt", "=", sort), eb("id", "<", id)])]),
        );
      }
      const rows = await selection.execute();
      return toPage(
        rows.map((row) => MultiplayerResult.parse(row)),
        limit,
        (result) => ({ sort: result.resolvedAt.getTime(), id: result.id }),
      );
    },

    async byVoidKey(voidKey) {
      const row = await db
        .selectFrom(MULTIPLAYER_VOID_KEYS_TABLE)
        .innerJoin(
          MULTIPLAYER_RESULTS_TABLE,
          `${MULTIPLAYER_RESULTS_TABLE}.sessionId`,
          `${MULTIPLAYER_VOID_KEYS_TABLE}.sessionId`,
        )
        .selectAll(MULTIPLAYER_RESULTS_TABLE)
        .where(`${MULTIPLAYER_VOID_KEYS_TABLE}.voidKey`, "=", voidKey)
        .executeTakeFirst();
      return row ? MultiplayerResult.parse(row) : undefined;
    },

    async spentAt(voidKey) {
      const row = await db
        .selectFrom(MULTIPLAYER_VOID_KEYS_TABLE)
        .selectAll()
        .where("voidKey", "=", voidKey)
        .executeTakeFirst();
      return row ? MultiplayerVoidKey.parse(row).spentAt : undefined;
    },

    async markVoided(sessionId, voidKey, consumers, at) {
      const counts: ResultCondition = (eb) => eb("voidedAt", "is", null);
      // The key's insert goes first: the batch is one transaction, and the update would make its condition false.
      const results = await d1.batch([
        prepared(spend(sessionId, voidKey, at, counts)),
        prepared(
          db
            .updateTable(MULTIPLAYER_RESULTS_TABLE)
            .set({
              voidedAt: MultiplayerResult.shape.voidedAt.encode(at),
              voidKey,
              voidConsumers: encodedConsumers(consumers),
            } as never)
            .where("sessionId", "=", sessionId)
            .where(counts),
        ),
      ]);
      return spent(results);
    },

    async claimRetry(sessionId, fromKey, toKey, at, consumers) {
      const held: ResultCondition = (eb) =>
        eb.and([
          eb("voidedAt", "is not", null),
          fromKey === null ? eb("voidKey", "is", null) : eb("voidKey", "=", fromKey),
        ]);
      // As in `markVoided`: the insert first, while the result still holds `fromKey`.
      const results = await d1.batch([
        prepared(spend(sessionId, toKey, at, held)),
        prepared(
          db
            .updateTable(MULTIPLAYER_RESULTS_TABLE)
            .set({ voidKey: toKey, voidConsumers: encodedConsumers(consumers) } as never)
            .where("sessionId", "=", sessionId)
            .where(held),
        ),
      ]);
      return spent(results);
    },

    async recordConsumers(sessionId, consumers) {
      await db
        .updateTable(MULTIPLAYER_RESULTS_TABLE)
        .set({ voidConsumers: encodedConsumers(consumers) } as never)
        .where("sessionId", "=", sessionId)
        .execute();
    },
  };
}

/**
 * Whether a D1 error is a UNIQUE violation — how a void whose key was spent on another result is told apart.
 * SQLite's wording is the only signal D1 gives, so it is matched on the error and every `cause` beneath it.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    const message = (current as { message?: unknown }).message ?? current;
    if (/UNIQUE constraint failed/i.test(String(message))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
