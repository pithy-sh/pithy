// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, type StorageDatabase } from "../data/tables";
import { isDerivedObjectKey, OBJECT_KEY_PREFIX } from "../object/key";
import type { ObjectStore } from "../object/store";
import { QUOTA_COUNTED_STATUSES } from "../quota/quota";

/**
 * The orphan sweep: reconciling two stores that can only ever be *eventually* consistent.
 *
 * A file is two writes — a row in D1 and an object in R2 — and no transaction spans them. Every
 * interruption between the two leaves one behind, and the divergence goes **both** ways:
 *
 *   - **A row with no object.** An upload started (the row reserves its quota) and never finished.
 *     The reservation is real: it counts against the owner's limit forever unless something returns
 *     it. This is the direction that silently locks a user out of their own quota.
 *   - **An object no row bills for.** A delete removed the row and then failed on R2, a client uploaded
 *     to a presigned URL after its row was deleted, or an upload was aborted and the URL used anyway —
 *     the row survives as `failed` and reserves nothing. The bytes are unreachable and unbilled to
 *     anyone — a pure leak, paid for monthly.
 *
 * A sweep that only walked one direction would leave the other to accumulate indefinitely, so this
 * one does both, in that order: reclaiming rows first means an object whose row was just dropped is
 * caught by the same run rather than waiting a day for the next.
 *
 * **Two things keep it from deleting live data.** Only keys carrying storage's own `obj/` prefix are
 * ever considered, so a bucket shared with another tool is left alone. And an object is only orphaned
 * if it is *older than the cutoff*: a row is written before its upload URL is minted, but R2's view
 * and D1's view of "now" are independent, and an object uploaded seconds ago whose row this run has
 * not yet read is not an orphan — it is a race. The age check turns that race into a wait.
 *
 * Pure over injected dependencies: no bindings, no `cloudflare:workers`, no config import. The
 * Workflow in `worker.ts` is a durable shell around this function, which is what makes the reconciling
 * logic testable against a deliberately divergent bucket and table.
 */

/** What one sweep run needs. */
export interface SweepDeps {
  /** The storage database. */
  db: StorageDatabase;
  /** The object plane — used for `abortMultipart`, `delete`, and the bucket listing. */
  store: ObjectStore;
  /** The current time. */
  now: () => Date;
  /** How old a `pending` row (and an unmatched object) must be before it is reclaimed. */
  ttlSeconds: number;
  /** Report and delete nothing. */
  dryRun?: boolean;
  /** Cap on bucket pages scanned in one run. */
  maxPages?: number;
  /**
   * Keys per bucket list page. Defaults to R2's own cap of 1,000, which is what a real run should ask
   * for. Exposed so a test can force pagination without writing a thousand objects — the paging and
   * truncation logic is otherwise only reachable at a scale no test suite should pay for.
   */
  pageSize?: number;
}

/** What one sweep run found and did. */
export interface SweepResult {
  /** `pending` rows past the TTL: their uploads aborted, their bytes dropped, their rows removed. */
  reclaimedRows: number;
  /** Bucket objects with no row, older than the cutoff: deleted. */
  deletedObjects: number;
  /** Bucket objects examined — the run's cost, and how a `maxPages` cap is noticed. */
  scannedObjects: number;
  /** Whether the run stopped at its page cap with more of the bucket unexamined. */
  truncated: boolean;
  /** Whether this run only reported. */
  dryRun: boolean;
}

/** R2's own cap on a list page. Asking for more is silently clamped, so ask for exactly this. */
const LIST_PAGE_SIZE = 1000;

/** Default cap on pages per run: a million keys, which is a long sweep and a sane bound. */
const DEFAULT_MAX_PAGES = 1000;

/**
 * The membership lookup binds its status filter besides the key list, so the chunk gets D1's budget
 * less those two. Add another `where` to that query and this number moves with it.
 */
const CLAIMED_KEYS_FIXED_PARAMETERS = QUOTA_COUNTED_STATUSES.length;

/**
 * Reclaim `pending` rows older than the cutoff.
 *
 * Each row's in-flight multipart is aborted (R2 bills stored parts, so leaving them is a real cost),
 * then any bytes that did land are deleted, then the row goes — object first, row second, so a
 * failure part-way leaves an object with no row, which the second phase collects. The other order
 * would leave a row pointing at nothing, which nothing collects.
 *
 * Both R2 calls are best-effort. An upload id R2 has already forgotten, or a key that was never
 * written, must not stop the row from being reclaimed — the whole point of the run is to unwedge
 * state, not to insist it was tidy.
 */
async function reclaimPendingRows(deps: SweepDeps, cutoff: Date): Promise<number> {
  const rows = await deps.db
    .selectFrom(STORAGE_OBJECTS_TABLE)
    .selectAll()
    .where("status", "=", "pending")
    // Through the codec, never a hand-written epoch: the column's encoding is the schema's to decide.
    .where("createdAt", "<", SQLiteDate.encode(cutoff))
    .execute();

  if (deps.dryRun) return rows.length;

  let reclaimed = 0;
  for (const row of rows) {
    const object = StorageObject.parse(row);
    if (object.uploadId) await deps.store.abortMultipart(object.key, object.uploadId).catch(() => {});
    await deps.store.delete(object.key).catch(() => {});
    await deps.db.deleteFrom(STORAGE_OBJECTS_TABLE).where("id", "=", object.id).execute();
    reclaimed += 1;
  }
  return reclaimed;
}

/**
 * Delete bucket objects that no row claims.
 *
 * **A row claims a key only while it bills for it.** The membership test filters on the same statuses
 * the quota sums ({@link QUOTA_COUNTED_STATUSES}), so a `failed` row — the record an abort or a refused
 * completion leaves behind — reserves nothing *and* shields nothing. Without that filter the two
 * predicates disagree, and the disagreement is a leak with no floor: abort a single-PUT upload, PUT to
 * the presigned URL you still hold, and the surviving `failed` row marks the key as claimed forever
 * while `usedBytes` counts none of it. Phase one skips it (it only reclaims `pending` rows), so nothing
 * automated would ever collect those bytes again.
 *
 * The row itself is left alone either way. It is the owner's record that an upload was attempted and
 * abandoned; only its claim on the bytes is withdrawn.
 *
 * The membership test is a batched `WHERE key IN (…)` rather than one query per key: a page is a
 * thousand keys, and a thousand round trips to D1 is the difference between a sweep that finishes and
 * one that times out. It is batched rather than one query per page because D1 caps a statement at 100
 * bound parameters and a page carries up to a thousand keys — so the page is chunked under that cap
 * and the claimed sets unioned before anything is deleted. The two limits are unrelated knobs: the
 * page size is R2's listing cost, the chunk size is D1's statement cost, and tying one to the other
 * would be a coincidence rather than a reason.
 *
 * Only keys this capability derived are considered, and only ones older than the cutoff — see the
 * module comment on why the age check is load-bearing rather than cautious.
 */
async function deleteOrphanedObjects(
  deps: SweepDeps,
  cutoff: Date,
): Promise<{ deleted: number; scanned: number; truncated: boolean }> {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let cursor: string | undefined;
  let deleted = 0;
  let scanned = 0;
  let pages = 0;

  for (;;) {
    const page = await deps.store.list({ prefix: OBJECT_KEY_PREFIX, cursor, limit: deps.pageSize ?? LIST_PAGE_SIZE });
    pages += 1;
    scanned += page.objects.length;

    const candidates = page.objects.filter(
      (object) => isDerivedObjectKey(object.key) && object.uploaded.getTime() < cutoff.getTime(),
    );
    if (candidates.length > 0) {
      const keys = candidates.map((object) => object.key);
      const claimed = new Set<string>();
      for (const group of chunkByBoundParameters(keys, CLAIMED_KEYS_FIXED_PARAMETERS)) {
        const known = await deps.db
          .selectFrom(STORAGE_OBJECTS_TABLE)
          .select("key")
          .where("key", "in", group)
          .where("status", "in", [...QUOTA_COUNTED_STATUSES])
          .execute();
        for (const row of known) claimed.add(row.key);
      }
      for (const object of candidates) {
        if (claimed.has(object.key)) continue;
        if (!deps.dryRun) await deps.store.delete(object.key).catch(() => {});
        deleted += 1;
      }
    }

    cursor = page.cursor;
    if (!cursor) return { deleted, scanned, truncated: false };
    if (pages >= maxPages) return { deleted, scanned, truncated: true };
  }
}

/**
 * Run one sweep. Idempotent by construction — a second run over a reconciled bucket finds nothing and
 * deletes nothing — so a retried Workflow step, a manual trigger after a cron, and a nervous operator
 * running it twice all cost the same.
 */
export async function sweepStorage(deps: SweepDeps): Promise<SweepResult> {
  const cutoff = new Date(deps.now().getTime() - deps.ttlSeconds * 1000);
  const reclaimedRows = await reclaimPendingRows(deps, cutoff);
  const objects = await deleteOrphanedObjects(deps, cutoff);
  return {
    reclaimedRows,
    deletedObjects: objects.deleted,
    scannedObjects: objects.scanned,
    truncated: objects.truncated,
    dryRun: deps.dryRun === true,
  };
}
