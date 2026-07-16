import type { KVNamespace } from "@cloudflare/workers-types";
import { TypedKv } from "@pithy-sh/core/src/kv/kv";
import { z } from "zod";
import { MediaNotFoundError } from "../error/errors";
import type { ListRecordsOptions, MediaRecord, PhashEntry, RecordStore } from "./store";

/** Default page size for {@link RecordStore.list}. */
const DEFAULT_LIMIT = 50;

/** The KV key: the fixed `media` prefix plus the record id — `media:<id>`. */
const MediaKey = z
  .object({ id: z.string().describe("The media record id — the KV key segment.") })
  .describe("The KV key for a media record: `media:<id>`.");

/**
 * The KV-backed record store — the `recordStore: 'kv'` opt-in for KV-only projects. Records are typed
 * KV values (`media:<id>`), validated whole against the effective schema on every read and write, so
 * extension fields round-trip exactly as in D1 with no columns and no migration.
 *
 * KV is a key-value store, not a query engine. `get`/`patch`/`delete` are direct key lookups, but
 * `list`, `findBySha256`, and `listImagePhashes` must **scan** the namespace (list keys, read each value,
 * filter in memory). That is fine for modest media sets and is why D1 is the default: transcription and
 * extracted-text search effectively require D1. This limitation is documented in the package README.
 */
export function kvRecordStore(namespace: KVNamespace, schema: z.ZodObject): RecordStore {
  const kv = new TypedKv(namespace, { prefix: "media", key: MediaKey, value: schema });

  /** Read and validate every stored record — the scan primitive the query methods build on. */
  const scanAll = async (): Promise<MediaRecord[]> => {
    const records: MediaRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ cursor, limit: 1000 });
      for (const entry of page.keys) {
        const value = await kv.get({ id: entry.key.id });
        if (value) records.push(value as MediaRecord);
      }
      cursor = page.cursor;
    } while (cursor);
    return records;
  };

  return {
    async create(record) {
      await kv.put({ id: String(record.id) }, record);
      return (await kv.get({ id: String(record.id) })) as MediaRecord;
    },

    async get(id) {
      return (await kv.get({ id })) as MediaRecord | null;
    },

    async patch(id, changes) {
      const existing = await kv.get({ id });
      if (!existing) {
        throw new MediaNotFoundError({ detail: `no media record to patch for id ${id}` });
      }
      const merged = { ...(existing as object), ...(changes as object) } as MediaRecord;
      await kv.put({ id }, merged);
      return merged;
    },

    async delete(id) {
      await kv.delete({ id });
    },

    async list(options: ListRecordsOptions = {}) {
      const limit = options.limit ?? DEFAULT_LIMIT;
      const all = await scanAll();
      const filtered = options.type ? all.filter((record) => record.type === options.type) : all;
      // Newest first — the same order D1 returns.
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const offset = decodeCursor(options.cursor);
      const items = filtered.slice(offset, offset + limit);
      const cursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
      return { items, cursor };
    },

    async findBySha256(sha256) {
      const all = await scanAll();
      return all.filter((record) => record.sha256 === sha256);
    },

    async listImagePhashes() {
      const all = await scanAll();
      const entries: PhashEntry[] = [];
      for (const record of all) {
        if (record.type === "image" && typeof record.phash === "string" && record.phash.length > 0) {
          entries.push({ id: String(record.id), phash: record.phash });
        }
      }
      return entries;
    },
  };
}

/** Decode an opaque cursor back to an integer offset; a missing or malformed cursor starts at 0. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
