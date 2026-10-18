// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MediaType, StorageBackend } from "../data/enums";
import { MEDIA_ASSETS_TABLE, type MediaDatabase } from "../data/tables";

/** One asset the delivery read joins Cloudflare's numbers to: its record, and the key Cloudflare counts it by. */
export interface DeliveredAsset {
  /** The media record's id. */
  id: string;
  /** The record's display name. */
  name: string;
  /** The Cloudflare Stream uid or Images id — what the analytics datasets group by. */
  storageKey: string;
}

/** Every stored asset of one type on one backend, in this environment. */
export type StoredAssetReader = (type: MediaType, backend: StorageBackend) => Promise<DeliveredAsset[]>;

/**
 * **This environment's half of the delivery join (#728).** Every stored asset of one type on one Cloudflare
 * product, from this environment's own database — whoever owns it, because the read behind it is the
 * environment's operator's, gated by a control-plane scope, never a caller's.
 *
 * A query of its own rather than `RecordStore.list`, deliberately: that listing answers only what one
 * caller may see, and has no parameter that could ask for more. Three columns and nothing else, so the
 * read carries no field it does not report.
 */
export function storedAssets(db: MediaDatabase): StoredAssetReader {
  return async (type, backend) => {
    const rows = await db
      .selectFrom(MEDIA_ASSETS_TABLE)
      .select(["id", "name", "storageKey"])
      .where("type", "=", type)
      .where("status", "=", "stored")
      .where("storageBackend", "=", backend)
      .execute();
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), storageKey: String(row.storageKey) }));
  };
}
