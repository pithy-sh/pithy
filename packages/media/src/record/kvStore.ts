// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { KVNamespace } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
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
  // Always include the fields `list` needs (type, createdAt). Field names are validated against the
  // effective schema at capability construction (see `assertValidKvMetadata`), so no shape filter here —
  // the metadata is derived from the value by name, which lets an adopter's extension field ride along
  // even in the enrichment worker, whose passthrough schema does not carry the extension in its shape.
  const fields = [...new Set([...REQUIRED_METADATA_FIELDS, ...metadataFields])];
  // A size-bounded, permissive metadata object: the projected fields (including extension fields the
  // schema's `shape` may not list) validate as a small denormalized bag for list controls.
  const metadataSchema = kvMetadata(z.record(z.string(), z.unknown()));

  const kv = new TypedKv(namespace, {
    prefix: "media",
    key: MediaKey,
    value: schema,
    metadata: metadataSchema,
    deriveMetadata: (value) => {
      const record = value as Record<string, unknown>;
      const meta: Record<string, unknown> = {};
      for (const field of fields) {
        if (record[field] !== undefined) meta[field] = record[field];
      }
      return meta;
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
      // `createdAt` round-trips through KV as a JSON (ISO) value, so normalize it to an epoch for sorting.
      const entries: Array<{ id: string; type: unknown; createdAt: number }> = [];
      let listCursor: string | undefined;
      do {
        const page = await kv.list({ cursor: listCursor, limit: 1000 });
        for (const entry of page.keys) {
          const meta = entry.metadata as { type?: unknown; createdAt?: unknown } | null;
          entries.push({ id: entry.key.id, type: meta?.type, createdAt: toEpoch(meta?.createdAt) });
        }
        listCursor = page.cursor;
      } while (listCursor);

      const filtered = options.type ? entries.filter((entry) => entry.type === options.type) : entries;
      // Newest first — the same order D1 returns.
      filtered.sort((a, b) => b.createdAt - a.createdAt);

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

/** Normalize a metadata `createdAt` (ISO string, epoch number, or Date) to an epoch; 0 when absent/invalid. */
function toEpoch(value: unknown): number {
  if (value == null) return 0;
  const time = new Date(value as string | number | Date).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Validate the adopter's `kvMetadata` field names against the effective record schema, so a typo or an
 * unknown field fails fast at capability construction with a clear message — never silently ignored.
 * Called by `media()`; `type`/`createdAt` are always included by the store and need not be listed.
 */
export function assertValidKvMetadata(fields: readonly string[], schema: z.ZodObject): void {
  const valid = new Set(Object.keys(schema.shape));
  const unknownFields = fields.filter((field) => !valid.has(field));
  if (unknownFields.length > 0) {
    throw new InternalError({
      message: `Unknown kvMetadata field(s): ${unknownFields.join(", ")}.`,
      action: "Every kvMetadata entry must be a record field (a base field or one added via media({ extend })).",
      detail: `Valid record fields: ${[...valid].join(", ")}`,
    });
  }
}
