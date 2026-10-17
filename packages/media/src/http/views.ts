// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type AccessCaller, disclosedTenancy } from "@pithy-sh/core/src/access/access";
import type { MediaRecord } from "../record/store";

/**
 * Whether Cloudflare's signing setting has not caught up with a record's visibility.
 *
 * Only a Cloudflare Images or Stream asset has a setting to lag: an R2 object is private by its bucket.
 * A non-public record whose bytes are not yet signed is the state a failed public-to-private change, and
 * every record the ownership migration made private, is left in; a public record whose bytes are still
 * signed is the state a failed private-to-public change leaves. Both are finished by sending the
 * visibility again.
 */
export function signingPending(record: MediaRecord): boolean {
  if (record.storageBackend === "r2") return false;
  return (record.visibility !== "public") !== record.signedDelivery;
}

/**
 * A record as one caller sees it: every stored field, adopter extensions included, and its signing state.
 *
 * The owner and organization are the caller's to see only when they act for the record's organization
 * ({@link disclosedTenancy}). A public record reached from anywhere else names neither: reading a file is not
 * learning which organization its owner belongs to.
 */
export function mediaView(record: MediaRecord, caller: AccessCaller): MediaRecord & { signingPending: boolean } {
  return { ...record, ...disclosedTenancy(record, caller), signingPending: signingPending(record) };
}
