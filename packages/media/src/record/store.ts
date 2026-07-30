// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MediaType } from "../data/enums";
import type { MediaAsset } from "../data/mediaAsset";

/**
 * A stored media record: the base {@link MediaAsset} plus whatever fields the adopter added through
 * `media({ extend })`. The extra fields are unknown at the package's type level but validated at runtime
 * by the effective schema, so they round-trip through create/get/list unchanged.
 */
export type MediaRecord = MediaAsset & Record<string, unknown>;

/** Options for listing records. Filtering by `type` is precise in D1 and a scan-filter in KV. */
export interface ListRecordsOptions {
  /** Restrict to one media type. */
  type?: MediaType;
  /** Maximum records per page. Defaults to 50. */
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
}

/** A page of listed records with an optional continuation cursor. */
export interface RecordPage {
  /** The records on this page. */
  items: MediaRecord[];
  /** Cursor for the next page, or undefined when the listing is complete. */
  cursor?: string;
}

/**
 * The record-store seam: one interface, two backends. `recordStore: 'd1'` (default) persists to the
 * `pithy_media_assets` table with queryable derived text; `recordStore: 'kv'` persists to a KV namespace
 * (key lookup; `list` scans, documented as such). Both validate every read and write against the effective
 * schema, so an adopter's extension fields survive with no backend-specific work. Duplicate detection is
 * NOT here — it always runs against the D1 {@link HashStore}, independent of the record store.
 */
export interface RecordStore {
  /** Persist a new record. Returns the stored, re-validated record. */
  create(record: MediaRecord): Promise<MediaRecord>;
  /** Read a record by id, or null on a miss. */
  get(id: string): Promise<MediaRecord | null>;
  /** Merge `changes` over the current record, validate, and write it back. Throws if the id is unknown. */
  patch(id: string, changes: Partial<MediaRecord>): Promise<MediaRecord>;
  /** Delete a record by id. A miss is a no-op. */
  delete(id: string): Promise<void>;
  /** List records, newest first, optionally filtered by type. */
  list(options?: ListRecordsOptions): Promise<RecordPage>;
}
