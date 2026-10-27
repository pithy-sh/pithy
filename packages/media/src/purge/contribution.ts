// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { isNotFoundError } from "@pithy-sh/cloudflare/src/client/errors";
import { type ErasingPurgeContribution, exportRows } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import type { MediaConfig } from "../config/config";
import type { StorageBackend } from "../data/enums";
import { MediaAsset } from "../data/mediaAsset";
import {
  MEDIA_ASSETS_TABLE,
  MEDIA_HASHES_TABLE,
  type MediaDatabase,
  mediaDatabase,
  mediaHashDatabase,
} from "../data/tables";
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

/** The one sentence a person's purge records with this step (#814). */
export const MEDIA_USER_PURGE_SUMMARY =
  "Deletes every media record the user holds as themselves, with its stored bytes in R2, Cloudflare Images or Stream, and its dedup hashes. A record they made for an organization is the organization's.";

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
      detail: "media purge contribution found no DB binding on the env",
    });
  }
  return binding as D1Database;
}

/** Which records one erase reaches: an organization's, or a person's own. */
type Holder = { readonly organizationId: string } | { readonly ownerId: string };

/** The records `holder` holds, as a filter on the asset table. */
function held(db: MediaDatabase, holder: Holder) {
  const records = db.selectFrom(MEDIA_ASSETS_TABLE);
  return "organizationId" in holder
    ? records.where("organizationId", "=", holder.organizationId)
    : records.where("ownerId", "=", holder.ownerId).where("organizationId", "is", null);
}

/** Erase every record `holder` holds — bytes, then hashes, then the row — a page at a time. See the header. */
async function eraseHeld(
  env: Record<string, unknown>,
  holder: Holder,
  storage: (env: Record<string, unknown>) => Promise<MediaStorage>,
): Promise<void> {
  const d1 = bindingOf(env);
  const records = mediaDatabase(d1);
  const hashes = mediaHashDatabase(d1);
  let seam: MediaStorage | undefined;
  for (;;) {
    const page = await held(records, holder).select(["id", "storageBackend", "storageKey"]).limit(PAGE).execute();
    if (page.length === 0) return;
    // Resolved only once there is something to delete, so a holder with no media reads no secret.
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
}

/** The Worker's own storage seam, from its env, for a resolved config. */
function workerStorage(config: MediaConfig): (env: Record<string, unknown>) => Promise<MediaStorage> {
  return (env) => resolveStorage(env as unknown as StorageEnv, config);
}

/**
 * The organization contribution `media()` declares, over its resolved config. `storage` is the seam the bytes
 * are deleted through — the Worker's own, from its env, unless a test hands one in.
 */
export function mediaOrganizationPurge(
  config: MediaConfig,
  storage: (env: Record<string, unknown>) => Promise<MediaStorage> = workerStorage(config),
): ErasingPurgeContribution {
  return {
    subject: "organization",
    summary: MEDIA_ORGANIZATION_PURGE_SUMMARY,
    erase: ({ subject, env }) => eraseHeld(env, { organizationId: subject.id }, storage),
  };
}

/**
 * The user contribution `media()` declares (#814): a person's own records, erased as above and exported first.
 * `schema` is the effective record schema — the adopter's extension columns included — so the export decodes them.
 */
export function mediaUserPurge(
  config: MediaConfig,
  schema: z.ZodObject = MediaAsset,
  storage: (env: Record<string, unknown>) => Promise<MediaStorage> = workerStorage(config),
): ErasingPurgeContribution {
  return {
    subject: "user",
    summary: MEDIA_USER_PURGE_SUMMARY,
    erase: ({ subject, env }) => eraseHeld(env, { ownerId: subject.id }, storage),
    export: async ({ subject, env }) => {
      const rows = await held(mediaDatabase(bindingOf(env)), { ownerId: subject.id })
        .selectAll()
        .orderBy("createdAt")
        .orderBy("id")
        .execute();
      return { records: exportRows(rows.map((row) => schema.parse(row))) };
    },
  };
}
