// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { PurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { STORAGE_OBJECTS_TABLE, STORAGE_SHARES_TABLE, storageDatabase } from "../data/tables";
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
 */

/** The one sentence the purge records with this step. */
export const STORAGE_ORGANIZATION_PURGE_SUMMARY =
  "Deletes every file the organization holds, with its bytes in R2 and every share link to it.";

/** How many files one read takes, so an organization with many files is erased in bounded statements. */
const PAGE = 100;

/** One binding off a run's env, or a wiring fault naming it. */
function bindingOf<T>(env: Record<string, unknown>, name: string, kind: string): T {
  const binding = env[name];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: "Storage is not bound, so this purge step could not run.",
      action: `Bind ${kind} named ${name} to the Worker that runs the purge.`,
      detail: `storage organization purge contribution found no ${name} binding on the env`,
    });
  }
  return binding as T;
}

/** The organization contribution `storage()` declares. */
export function storageOrganizationPurge(): PurgeContribution {
  return {
    subject: "organization",
    summary: STORAGE_ORGANIZATION_PURGE_SUMMARY,
    erase: async ({ subject, env }) => {
      const db = storageDatabase(bindingOf<D1Database>(env, "DB", "a D1 database"));
      const bucket = bindingOf<R2Bucket>(env, STORAGE_BUCKET_BINDING, "an R2 bucket");
      // Credentials resolve lazily inside the store, so a purge with no multipart upload in flight reads no secret.
      const store = objectStore({ bucket, env: env as unknown as SecretsStoreEnv, secretName: STORAGE_R2_SECRET });
      for (;;) {
        const page = await db
          .selectFrom(STORAGE_OBJECTS_TABLE)
          .select(["id", "key", "uploadId"])
          .where("organizationId", "=", subject.id)
          .limit(PAGE)
          .execute();
        if (page.length === 0) return;
        for (const object of page) {
          if (object.uploadId) await store.abortMultipart(object.key, object.uploadId).catch(() => {});
          await store.delete(object.key);
          await db.deleteFrom(STORAGE_SHARES_TABLE).where("objectId", "=", object.id).execute();
          await db.deleteFrom(STORAGE_OBJECTS_TABLE).where("id", "=", object.id).execute();
        }
      }
    },
  };
}
