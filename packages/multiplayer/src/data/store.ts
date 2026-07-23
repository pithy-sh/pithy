import { MultiplayerResult } from "./result";
import { MULTIPLAYER_RESULTS_TABLE, type MultiplayerDatabase } from "./tables";

/**
 * Reads and writes over `pithy_multiplayer_results`.
 *
 * Round-trip rule (CLAUDE.md §Data layer): read with `MultiplayerResult.parse` (decode), write with
 * `MultiplayerResult.encode` (encode). No raw `0/1`, epoch, or `JSON.stringify` below.
 */
export interface ResultStore {
  /**
   * Persist a terminal session's result. Idempotent on `sessionId`: an at-least-once alarm retry or a
   * double-resolve writes the row once and no more, so a session can never record two conflicting results.
   */
  write(result: MultiplayerResult): Promise<void>;
  /** The result for a session, or undefined if it has not reached a terminal state. */
  get(sessionId: string): Promise<MultiplayerResult | undefined>;
}

export function resultStore(db: MultiplayerDatabase): ResultStore {
  return {
    async write(result) {
      const row = MultiplayerResult.encode({ ...result, id: 0 }) as Record<string, unknown>;
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

    async get(sessionId) {
      const row = await db
        .selectFrom(MULTIPLAYER_RESULTS_TABLE)
        .selectAll()
        .where("sessionId", "=", sessionId)
        .executeTakeFirst();
      return row ? MultiplayerResult.parse(row) : undefined;
    },
  };
}
