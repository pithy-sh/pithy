import type { KVNamespace } from "@cloudflare/workers-types";
import { kvMetadata, TypedKv } from "@pithy-sh/core/src/kv/kv";
import { z } from "zod";
import { MediaNotFoundError } from "../error/errors";
import type { ListRecordsOptions, MediaRecord, RecordStore } from "./store";

/** Default page size for {@link RecordStore.list}. */
const DEFAULT_LIMIT = 50;

/** The KV key: the fixed `media` prefix plus the record id — `media:<id>`. */
const MediaKey = z
  .object({ id: z.string().describe("The media record id — the KV key segment.") })
  .describe("The KV key for a media record: `media:<id>`.");

/** Fields the store always projects into metadata so `list` can filter by type and sort by recency. */
const REQUIRED_METADATA_FIELDS = ["type", "createdAt"];

/**
 * The KV-backed record store — the `recordStore: 'kv'` opt-in. Records are typed KV values (`media:<id>`),
 * validated whole against the effective schema on every read and write, so extension fields round-trip
 * exactly as in D1 with no columns and no migration.
 *
 * KV is a key-value store, not a query engine. `get`/`patch`/`delete` are direct key lookups. `list` is
 * made scalable by **KV metadata**: `metadataFields` (from `kvMetadata` config) are stored as each entry's
 * metadata, which rides free on a KV `list` — so `list` filters by type, sorts by recency, and paginates
 * from metadata alone, then reads only the returned page's values (bounded by the page size, not the
 * corpus). Put the fields your list views need (an owning `userId`, tags) in `kvMetadata`; KV caps
 * metadata at 1024 bytes, so keep them small. Duplicate detection is not here — it always uses D1.
 */
export function kvRecordStore(namespace: KVNamespace, schema: z.ZodObject, metadataFields: string[] = []): RecordStore {
  // Keep only real record fields; always include the fields `list` needs (type, createdAt).
  const shape = schema.shape as Record<string, unknown>;
  const fields = [...new Set([...REQUIRED_METADATA_FIELDS, ...metadataFields])].filter((field) => field in shape);
  const mask: Record<string, true> = {};
  for (const field of fields) mask[field] = true;
  const metadataSchema = kvMetadata(schema.pick(mask));

  const kv = new TypedKv(namespace, {
    prefix: "media",
    key: MediaKey,
    value: schema,
    metadata: metadataSchema,
    deriveMetadata: (value) => {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(fields.map((field) => [field, record[field]]));
    },
  });

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
      // A re-derive keeps metadata in step with the merged value.
      await kv.put({ id }, merged);
      return merged;
    },

    async delete(id) {
      await kv.delete({ id });
    },

    async list(options: ListRecordsOptions = {}) {
      const limit = options.limit ?? DEFAULT_LIMIT;

      // List every key with its metadata — cheap, no per-value reads. Filter and sort from metadata.
      const entries: Array<{ id: string; type: unknown; createdAt: Date | undefined }> = [];
      let listCursor: string | undefined;
      do {
        const page = await kv.list({ cursor: listCursor, limit: 1000 });
        for (const entry of page.keys) {
          const meta = entry.metadata as { type?: unknown; createdAt?: Date } | null;
          entries.push({ id: entry.key.id, type: meta?.type, createdAt: meta?.createdAt });
        }
        listCursor = page.cursor;
      } while (listCursor);

      const filtered = options.type ? entries.filter((entry) => entry.type === options.type) : entries;
      // Newest first — the same order D1 returns.
      filtered.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

      const offset = decodeCursor(options.cursor);
      const pageEntries = filtered.slice(offset, offset + limit);
      // Read only the page's values (bounded by `limit`, not the corpus size).
      const items: MediaRecord[] = [];
      for (const entry of pageEntries) {
        const value = await kv.get({ id: entry.id });
        if (value) items.push(value as MediaRecord);
      }
      const cursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
      return { items, cursor };
    },
  };
}

/** Decode an opaque cursor back to an integer offset; a missing or malformed cursor starts at 0. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
