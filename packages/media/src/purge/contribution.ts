// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { isNotFoundError } from "@pithy-sh/cloudflare/src/client/errors";
import type { PurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { MediaConfig } from "../config/config";
import type { StorageBackend } from "../data/enums";
import { MEDIA_ASSETS_TABLE, MEDIA_HASHES_TABLE, mediaDatabase, mediaHashDatabase } from "../data/tables";
import { resolveStorage, type StorageEnv } from "../storage/resolve";
import type { MediaStorage } from "../storage/storage";

/**
 * What erasing one organization means for `@pithy-sh/media` (#623): every record whose `organizationId` is the
 * organization's, with its stored bytes and its dedup hashes.
 *
 * **The bytes go first, then the row.** A record is the only thing that says where its bytes live — an R2 key,
 * a Cloudflare Images id, a Stream uid — so a row deleted ahead of its object would leave bytes nothing can find.
 * A delete that fails throws, and this step fails and retries alone; the rows not yet reached are still there to
 * name what is left. That is the difference from an owner's own delete, which is best-effort because a storage
 * hiccup must not leave a record undeletable: here, an erasure that reported success over surviving bytes would
 * be the failure.
 *
 * **Idempotent**, as the contract requires: an object already gone — a retry after the object went and the row
 * did not — is Cloudflare's 404, and that is this record having nothing left to erase. An organization with no
 * records is a step that finds nothing.
 *
 * Only `organizationId` decides. A record its owner wrote while acting for this organization is the
 * organization's, whoever the owner is and wherever else they belong; one they wrote for another organization,
 * or for none, is untouched.
 */

/** The one sentence the purge records with this step. */
export const MEDIA_ORGANIZATION_PURGE_SUMMARY =
  "Deletes every media record the organization holds, with its stored bytes in R2, Cloudflare Images or Stream, and its dedup hashes.";

/** How many records one read takes, so an organization with a large library is erased in bounded statements. */
const PAGE = 100;

/** Whether a failure is the object already being gone, anywhere down its cause chain. */
function alreadyGone(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 8; depth += 1) {
    if (isNotFoundError(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The D1 binding the media tables live in, off a run's env — or a wiring fault naming it. */
function bindingOf(env: Record<string, unknown>): D1Database {
  const binding = env.DB;
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "The media database is not bound, so this purge step could not run.",
      action: "Bind the DB D1 database to the Worker that runs the purge.",
      detail: "media organization purge contribution found no DB binding on the env",
    });
  }
  return binding as D1Database;
}

/**
 * The organization contribution `media()` declares, over its resolved config. `storage` is the seam the bytes
 * are deleted through — the Worker's own, from its env, unless a test hands one in.
 */
export function mediaOrganizationPurge(
  config: MediaConfig,
  storage: (env: Record<string, unknown>) => Promise<MediaStorage> = (env) =>
    resolveStorage(env as unknown as StorageEnv, config),
): PurgeContribution {
  return {
    subject: "organization",
    summary: MEDIA_ORGANIZATION_PURGE_SUMMARY,
    erase: async ({ subject, env }) => {
      const d1 = bindingOf(env);
      const records = mediaDatabase(d1);
      const hashes = mediaHashDatabase(d1);
      let seam: MediaStorage | undefined;
      for (;;) {
        const page = await records
          .selectFrom(MEDIA_ASSETS_TABLE)
          .select(["id", "storageBackend", "storageKey"])
          .where("organizationId", "=", subject.id)
          .limit(PAGE)
          .execute();
        if (page.length === 0) return;
        // Resolved only once there is something to delete, so an organization with no media reads no secret.
        seam ??= await storage(env);
        for (const record of page) {
          try {
            await seam.deleteObject({
              storageBackend: record.storageBackend as StorageBackend,
              storageKey: record.storageKey,
            });
          } catch (error) {
            if (!alreadyGone(error)) throw error;
          }
          await hashes.deleteFrom(MEDIA_HASHES_TABLE).where("mediaId", "=", record.id).execute();
          await records.deleteFrom(MEDIA_ASSETS_TABLE).where("id", "=", record.id).execute();
        }
      }
    },
  };
}
