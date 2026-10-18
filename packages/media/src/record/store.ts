// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { RawBuilder, SqlBool } from "kysely";
import type { MediaType } from "../data/enums";
import type { MediaAsset } from "../data/mediaAsset";

/**
 * A stored media record: the base {@link MediaAsset} plus whatever fields the adopter added through
 * `media({ extend })`. The extra fields are unknown at the package's type level but validated at runtime
 * by the effective schema, so they round-trip through create/get/list unchanged.
 */
export type MediaRecord = MediaAsset & Record<string, unknown>;

/** Options for listing records. */
export interface ListRecordsOptions {
  /**
   * Which records the caller may see, as SQL — `readablePredicate` from core's access rules. Required:
   * there is no list of every record in the account, and no parameter that could ask for one.
   */
  readable: RawBuilder<SqlBool>;
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
 * The record-store seam, over the `pithy_media_assets` table. Every read and write is validated against
 * the effective schema, so an adopter's extension fields survive with no extra work. Duplicate detection
 * is NOT here — it runs against the {@link import("./hashStore").HashStore}, which carries its own copy of
 * each record's tenant so its lookups are one scoped index read.
 */
export interface RecordStore {
  /**
   * Persist a new record. Returns the stored, re-validated record.
   *
   * With `ownerLimit`, the record is written **only if** its owner holds fewer than that many records — the
   * count and the insert one statement, so a burst of concurrent creates cannot walk past the limit — and
   * `null` is returned when it does not fit. A record with no owner is never limited.
   */
  create(record: MediaRecord, options?: { ownerLimit?: number }): Promise<MediaRecord | null>;
  /** Read a record by id, or null on a miss. The caller decides whether the reader may see it. */
  get(id: string): Promise<MediaRecord | null>;
  /** Merge `changes` over the current record, validate, and write it back. Throws if the id is unknown. */
  patch(id: string, changes: Partial<MediaRecord>): Promise<MediaRecord>;
  /** Delete a record by id. A miss is a no-op. */
  delete(id: string): Promise<void>;
  /** List the records a caller may see, newest first, optionally filtered by type. */
  list(options: ListRecordsOptions): Promise<RecordPage>;
}
