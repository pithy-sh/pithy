// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { type ErasingPurgeContribution, exportRows } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { StorageObject } from "../data/storageObject";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, type StorageDatabase, storageDatabase } from "../data/tables";
import { objectStore } from "../object/store";
import { STORAGE_BUCKET_BINDING, STORAGE_R2_SECRET } from "../secret/registry";

/**
 * What erasing one organization means for `@pithy-sh/storage` (#623): every file whose `organizationId` is the
 * organization's, with its bytes in R2 and every share link to it.
 *
 * **The bytes go first, then the shares, then the row** — the row is the only thing that names the key, so a row
 * deleted ahead of its object would leave bytes nothing can find. An R2 delete that fails throws, and this step
 * fails and retries alone, with the rows not yet reached still naming what is left. An in-flight multipart upload
 * is aborted best-effort, as the sweep aborts one: the abort is an S3-protocol call on the R2 credentials, and
 * parts it cannot reach expire under the bucket's own multipart lifecycle.
 *
 * **Idempotent**, as the contract requires: R2 deletes a missing key without complaint, and an organization with
 * no files is a step that finds nothing.
 *
 * Only `organizationId` decides. A file its owner wrote while acting for this organization is the organization's;
 * one written for another organization, or for none, is untouched.
 *
 * ## And one person's (#814)
 *
 * The same erase, for the files a person holds as themselves: `ownerId` is theirs and no organization holds the
 * file. One they wrote while acting for an organization is that organization's, and its purge is what erases it.
 * The export is those files' records — never a share link's token, which is the credential that opens one.
 */

/** The one sentence the purge records with this step. */
export const STORAGE_ORGANIZATION_PURGE_SUMMARY =
  "Deletes every file the organization holds, with its bytes in R2 and every share link to it.";

/** The one sentence a person's purge records with this step (#814). */
export const STORAGE_USER_PURGE_SUMMARY =
  "Deletes every file the user holds as themselves, with its bytes in R2 and every share link to it. A file they wrote for an organization is the organization's.";

/** How many files one read takes, so an organization with many files is erased in bounded statements. */
const PAGE = 100;

/** One binding off a run's env, or a wiring fault naming it. */
function bindingOf<T>(env: Record<string, unknown>, name: string, kind: string): T {
  const binding = env[name];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "Storage is not bound, so this purge step could not run.",
      action: `Bind ${kind} named ${name} to the Worker that runs the purge.`,
      detail: `storage purge contribution found no ${name} binding on the env`,
    });
  }
  return binding as T;
}

/** Which files one erase reaches: an organization's, or a person's own. */
type Holder = { readonly organizationId: string } | { readonly ownerId: string };

/** The files `holder` holds, as a filter on the objects table. */
function held(db: StorageDatabase, holder: Holder) {
  const files = db.selectFrom(STORAGE_OBJECTS_TABLE);
  return "organizationId" in holder
    ? files.where("organizationId", "=", holder.organizationId)
    : files.where("ownerId", "=", holder.ownerId).where("organizationId", "is", null);
}

/** Erase every file `holder` holds — bytes, then shares, then the row — a page at a time. See the header. */
async function eraseHeld(env: Record<string, unknown>, holder: Holder): Promise<void> {
  const db = storageDatabase(bindingOf<D1Database>(env, "DB", "a D1 database"));
  const bucket = bindingOf<R2Bucket>(env, STORAGE_BUCKET_BINDING, "an R2 bucket");
  // Credentials resolve lazily inside the store, so a purge with no multipart upload in flight reads no secret.
  const store = objectStore({ bucket, env: env as unknown as SecretsStoreEnv, secretName: STORAGE_R2_SECRET });
  for (;;) {
    const page = await held(db, holder).select(["id", "key", "uploadId"]).limit(PAGE).execute();
    if (page.length === 0) return;
    for (const object of page) {
      if (object.uploadId) await store.abortMultipart(object.key, object.uploadId).catch(() => {});
      await store.delete(object.key);
      await db.deleteFrom(STORAGE_SHARES_TABLE).where("objectId", "=", object.id).execute();
      await db.deleteFrom(STORAGE_OBJECTS_TABLE).where("id", "=", object.id).execute();
    }
  }
}

/** The organization contribution `storage()` declares. */
export function storageOrganizationPurge(): ErasingPurgeContribution {
  return {
    subject: "organization",
    summary: STORAGE_ORGANIZATION_PURGE_SUMMARY,
    erase: ({ subject, env }) => eraseHeld(env, { organizationId: subject.id }),
  };
}

/** The user contribution `storage()` declares (#814): a person's own files, erased as above and exported first. */
export function storageUserPurge(): ErasingPurgeContribution {
  return {
    subject: "user",
    summary: STORAGE_USER_PURGE_SUMMARY,
    erase: ({ subject, env }) => eraseHeld(env, { ownerId: subject.id }),
    export: async ({ subject, env }) => {
      const db = storageDatabase(bindingOf<D1Database>(env, "DB", "a D1 database"));
      const rows = await held(db, { ownerId: subject.id }).selectAll().orderBy("createdAt").orderBy("id").execute();
      return { files: exportRows(rows.map((row) => StorageObject.parse(row))) };
    },
  };
}
