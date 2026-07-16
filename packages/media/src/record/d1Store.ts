import type { z } from "zod";
import { MEDIA_ASSETS_TABLE, type MediaDatabase } from "../data/tables";
import { MediaNotFoundError } from "../error/errors";
import type { ListRecordsOptions, MediaRecord, RecordStore } from "./store";

/** Default page size for {@link RecordStore.list}. */
const DEFAULT_LIMIT = 50;

/** The row shape after `schema.encode` — a bag of SQLite-primitive columns. */
type EncodedRow = Record<string, unknown>;

/**
 * The D1-backed record store — the default. Records live in `pithy_media_assets`, one row each, read
 * and written through the effective schema's codecs (dates ↔ ms-epoch, booleans ↔ 0|1). Extension
 * columns ride along automatically: `schema.encode` includes them and Kysely writes every key present,
 * so an adopter's fields persist with no store changes. Derived text (`transcription`, `extractedText`)
 * is a real column, so it is queryable — the reason D1 is the default store.
 */
export function d1RecordStore(db: MediaDatabase, schema: z.ZodObject): RecordStore {
  /** Decode a raw D1 row into a validated record. */
  const decode = (row: unknown): MediaRecord => schema.parse(row) as MediaRecord;

  /** Encode an app-shape record into its SQLite row. */
  const encode = (record: MediaRecord): EncodedRow => schema.encode(record) as EncodedRow;

  const table = db.selectFrom(MEDIA_ASSETS_TABLE);

  return {
    async create(record) {
      const row = encode(record);
      // Kysely writes every runtime key on the object, so extension columns are inserted too; the cast
      // narrows the compile-time type to the base table without dropping those keys at runtime.
      await db
        .insertInto(MEDIA_ASSETS_TABLE)
        .values(row as never)
        .execute();
      return decode(row);
    },

    async get(id) {
      const row = await table.selectAll().where("id", "=", id).executeTakeFirst();
      return row ? decode(row) : null;
    },

    async patch(id, changes) {
      const existing = await table.selectAll().where("id", "=", id).executeTakeFirst();
      if (!existing) {
        throw new MediaNotFoundError({ detail: `no media record to patch for id ${id}` });
      }
      const merged = { ...(decode(existing) as object), ...(changes as object) } as MediaRecord;
      const row = encode(merged);
      await db
        .updateTable(MEDIA_ASSETS_TABLE)
        .set(row as never)
        .where("id", "=", id)
        .execute();
      return decode(row);
    },

    async delete(id) {
      await db.deleteFrom(MEDIA_ASSETS_TABLE).where("id", "=", id).execute();
    },

    async list(options: ListRecordsOptions = {}) {
      const limit = options.limit ?? DEFAULT_LIMIT;
      const offset = decodeCursor(options.cursor);
      let query = table.selectAll();
      if (options.type) query = query.where("type", "=", options.type);
      const rows = await query
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .offset(offset)
        .execute();
      const items = rows.slice(0, limit).map(decode);
      const cursor = rows.length > limit ? encodeCursor(offset + limit) : undefined;
      return { items, cursor };
    },
  };
}

/** Encode an integer offset as an opaque cursor string. */
function encodeCursor(offset: number): string {
  return String(offset);
}

/** Decode an opaque cursor back to an integer offset; a missing or malformed cursor starts at 0. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
