// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeCursor, pageLimit, toPage } from "@pithy-sh/core/src/data/cursor";
import { sql } from "kysely";
import { MultiplayerSessionEntry } from "./session";
import { MULTIPLAYER_SESSIONS_TABLE, type MultiplayerDatabase } from "./tables";

/** What a page of the index is asked for with. */
export interface SessionIndexQuery {
  /** Restrict to one game. Already resolved against config by the handler. */
  gameKey?: string;
  /** Where to resume, from a previous page's `nextCursor`. A malformed one is a first page. */
  cursor?: string;
  /** How many rows to return, clamped by `pageLimit`. */
  limit?: number;
}

/** One page of sessions in flight, newest first, and where the next one resumes. */
export interface SessionIndexPage {
  items: MultiplayerSessionEntry[];
  nextCursor: string | null;
}

/**
 * Reads and writes over `pithy_multiplayer_sessions`, the index of sessions in flight (#820).
 *
 * Only a session's own Durable Object writes it: {@link SessionIndex.put} when it opens and whenever its roster or
 * phase moves, {@link SessionIndex.remove} when it ends. Both are idempotent, so a retried transition writes the same
 * row or removes nothing.
 */
export interface SessionIndex {
  /**
   * Write a session's row: inserted when it opens, its phase and players rewritten after that. `openedAt` is kept
   * from the first write, so a session indexed late — one in flight when the index arrived — keeps the time the
   * session gave.
   */
  put(entry: Omit<MultiplayerSessionEntry, "id">): Promise<void>;
  /** Delete a session's row. A session with none is not an error. */
  remove(sessionId: string): Promise<void>;
  /** One session's row, or undefined when it is not in flight. */
  get(sessionId: string): Promise<MultiplayerSessionEntry | undefined>;
  /** Sessions in flight, newest first, a keyset page at a time. */
  list(query: SessionIndexQuery): Promise<SessionIndexPage>;
  /** Every session in flight that `userId` is a player in, oldest first. */
  withPlayer(userId: string): Promise<MultiplayerSessionEntry[]>;
}

export function sessionIndex(db: MultiplayerDatabase): SessionIndex {
  return {
    async put(entry) {
      const row = MultiplayerSessionEntry.encode({ ...entry, id: 0 }) as Record<string, unknown>;
      delete row.id;
      await db
        .insertInto(MULTIPLAYER_SESSIONS_TABLE)
        // biome-ignore lint/suspicious/noExplicitAny: the encoded row is the schema's `z.input` side; Kysely's insert type is derived from it.
        .values(row as any)
        .onConflict((oc) => oc.column("sessionId").doUpdateSet({ phase: row.phase, players: row.players } as never))
        .execute();
    },

    async remove(sessionId) {
      await db.deleteFrom(MULTIPLAYER_SESSIONS_TABLE).where("sessionId", "=", sessionId).execute();
    },

    async get(sessionId) {
      const row = await db
        .selectFrom(MULTIPLAYER_SESSIONS_TABLE)
        .selectAll()
        .where("sessionId", "=", sessionId)
        .executeTakeFirst();
      return row ? MultiplayerSessionEntry.parse(row) : undefined;
    },

    async list(query) {
      const limit = pageLimit(query.limit);
      const after = decodeCursor(query.cursor);
      let selection = db
        .selectFrom(MULTIPLAYER_SESSIONS_TABLE)
        .selectAll()
        .orderBy("openedAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1);
      if (query.gameKey !== undefined) selection = selection.where("gameKey", "=", query.gameKey);
      if (after !== undefined && typeof after.sort === "number" && typeof after.id === "number") {
        const { sort, id } = after;
        selection = selection.where((eb) =>
          eb.or([eb("openedAt", "<", sort), eb.and([eb("openedAt", "=", sort), eb("id", "<", id)])]),
        );
      }
      const rows = await selection.execute();
      return toPage(
        rows.map((row) => MultiplayerSessionEntry.parse(row)),
        limit,
        (entry) => ({ sort: entry.openedAt.getTime(), id: entry.id }),
      );
    },

    async withPlayer(userId) {
      const rows = await db
        .selectFrom(MULTIPLAYER_SESSIONS_TABLE)
        .selectAll()
        .where(sql<boolean>`exists (select 1 from json_each(players) where json_each.value = ${userId})`)
        .orderBy("openedAt")
        .orderBy("id")
        .execute();
      return rows.map((row) => MultiplayerSessionEntry.parse(row));
    },
  };
}
