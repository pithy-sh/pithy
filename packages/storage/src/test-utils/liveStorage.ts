// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { type IntegrationCreds, uniqueName, withThrowawayResource } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { STORAGE_MIGRATION_ORDER } from "../capability";
import { type StorageDatabase, storageDatabase } from "../data/tables";
import { storage_0001_objects } from "../migrations/0001_objects";
import { ObjectListing, ObjectMetadata, type ObjectStore, objectStore } from "../object/store";
import { type R2StorageCredentials, STORAGE_R2_SECRET, storageSecretsRegistry } from "../secret/registry";

/**
 * Scaffolding for this package's `*.integration.test.ts` suites — the live half of storage.
 *
 * `@pithy-sh/cloudflare`'s harness finds credentials and guarantees teardown. Storage needs two more
 * things on top: the seam under test built the way a Worker builds it (an {@link objectStore} over a
 * *resolved credential bundle*, not an injected fake), and a real database to reconcile against.
 *
 * **What is live here, and what cannot be.** The presigned half — presign, the whole multipart
 * lifecycle, server-side copy — is real R2 over the S3 protocol, and it is the half Miniflare cannot
 * emulate at all: it serves no S3 endpoint, so a presigned URL has nothing to address. The binding
 * half is the mirror image. An `R2Bucket` exists only inside workerd, so outside a Worker there is no
 * binding to call — {@link liveObjectStore} serves `head`, `list` and `delete` from the *same real
 * bucket* over S3 instead, and leaves `get` throwing.
 *
 * That split is deliberate and it is the whole reason the two suites are complementary rather than
 * redundant. `store.workers.test.ts` drives the binding against Miniflare with the presign half
 * throwing; this drives the presign half against real R2 with the binding-only read throwing. Neither
 * can quietly take the other's path and pass.
 */

/** One live object plane: the store under test, the bucket it addresses, and the S3 manager behind it. */
export interface LiveObjectPlane {
  /** The throwaway bucket's name. Every key in a test lands here and nowhere else. */
  bucketName: string;
  /** The seam under test — production `objectStore`, with the binding half served over S3. */
  store: ObjectStore;
  /** The S3 manager, for a test that needs an oracle the seam does not expose. */
  manager: CloudflareR2Manager;
}

/** One multipart upload this run opened and has not yet closed — teardown's list of what to abort. */
interface OpenUpload {
  key: string;
  uploadId: string;
}

/**
 * The R2 binding, deliberately absent.
 *
 * `objectStore` takes a bucket binding, and no such thing exists outside workerd. Rather than hand it
 * something that pretends, every method throws: a test that reaches the binding by accident fails
 * loudly instead of passing against a stand-in. The methods that matter are re-implemented over S3 in
 * {@link liveObjectStore}, so this is only ever reached by a path that has no live equivalent.
 */
function absentBinding(): R2Bucket {
  const refuse = (method: string) => () => {
    throw new Error(`R2 binding '${method}' has no equivalent outside a Worker — use the S3-backed seam.`);
  };
  return {
    get: refuse("get"),
    head: refuse("head"),
    put: refuse("put"),
    delete: refuse("delete"),
    list: refuse("list"),
    createMultipartUpload: refuse("createMultipartUpload"),
    resumeMultipartUpload: refuse("resumeMultipartUpload"),
  } as unknown as R2Bucket;
}

/**
 * Build the object store a live test drives.
 *
 * The credential path is the production one end to end: the bundle is injected as a `.dev.vars`-shaped
 * string under the registry name, `objectStore` resolves it through `sharedSecretsStore`, and the
 * registry's Zod schema validates it before a URL is ever signed. So a drift in
 * {@link R2StorageCredentials} fails here the same way it would fail in a deployed Worker.
 *
 * `head`, `list` and `delete` are then re-pointed at the same bucket over S3, because the binding they
 * would otherwise use does not exist in Node. `get` is left throwing: a range or a conditional read
 * through the binding has no S3 mapping this file could write without re-implementing workerd, and a
 * re-implementation is exactly the mock these tests exist to avoid. The suites assert R2's range and
 * conditional *semantics* over a presigned GET instead, where the answer comes from R2 itself.
 *
 * Multipart uploads are recorded as they open and forgotten as they close, so teardown can abort
 * whatever a failure left in flight — stored parts hold a bucket against deletion and cost money.
 */
function liveObjectStore(
  credentials: R2StorageCredentials,
  manager: CloudflareR2Manager,
  open: Map<string, OpenUpload>,
): ObjectStore {
  // Local dev's own resolution path: no `ENVIRONMENT` var, so every secret comes from its injected
  // string in the shape it is stored. Configuring the shared accessor also clears its TTL cache, which
  // is what keeps one test's bucket credentials from leaking into the next test's store.
  const env = { [STORAGE_R2_SECRET]: JSON.stringify(credentials) } as unknown as SecretsStoreEnv;
  configureSharedSecrets({ registry: storageSecretsRegistry });
  const store = objectStore({ bucket: absentBinding(), env });

  async function head(key: string): Promise<ObjectMetadata | null> {
    const object = await manager.headObject(key);
    if (!object) return null;
    if (!object.uploaded) throw new Error(`R2 reported no LastModified for '${key}'`);
    return ObjectMetadata.parse({
      key,
      size: object.size,
      // R2 quotes an ETag over the S3 protocol and leaves it unquoted through the binding. Strip it so
      // the seam's shape is identical either way — no caller should be able to tell which half served it.
      etag: object.etag.replace(/^"|"$/g, ""),
      contentType: object.contentType,
      uploaded: object.uploaded,
    });
  }

  return {
    ...store,

    async initMultipart(key, contentType) {
      const uploadId = await store.initMultipart(key, contentType);
      open.set(`${key}\0${uploadId}`, { key, uploadId });
      return uploadId;
    },

    async completeMultipart(key, uploadId, parts) {
      await store.completeMultipart(key, uploadId, parts);
      open.delete(`${key}\0${uploadId}`);
    },

    async abortMultipart(key, uploadId) {
      await store.abortMultipart(key, uploadId);
      open.delete(`${key}\0${uploadId}`);
    },

    head,

    async list(options) {
      const page = await manager.listObjects({
        prefix: options?.prefix,
        cursor: options?.cursor,
        maxKeys: options?.limit,
      });
      const objects: ObjectMetadata[] = [];
      for (const key of page.keys) {
        // A key listed and then deleted before its HEAD is not an error — a bucket is not a snapshot.
        const metadata = await head(key);
        if (metadata) objects.push(metadata);
      }
      return ObjectListing.parse({ objects, cursor: page.cursor });
    },

    async delete(key) {
      await manager.deleteObject(key);
    },

    get() {
      throw new Error("`get` reads through the R2 binding, which no Node context has. Presign a GET instead.");
    },
  };
}

/**
 * Empty a bucket so R2 will delete it — the same drain `pithy storage deprovision --storage` runs, so a
 * break in it fails a test here rather than an operator's teardown.
 *
 * Two things hold a bucket: stored objects, and the parts of a multipart upload that was never completed
 * or aborted — precisely what a test that failed mid-upload leaves behind. `emptyBucket` handles both.
 * The uploads this run opened are aborted first and best-effort, because a test may already have aborted
 * one and this map is only local bookkeeping; the authoritative sweep is R2's own listing inside
 * `emptyBucket`, which is also all a reaper cleaning up after a *previous* run has.
 */
async function purgeBucket(manager: CloudflareR2Manager, open: Map<string, OpenUpload>): Promise<void> {
  for (const upload of open.values()) {
    await manager.abortMultipartUpload(upload.key, upload.uploadId).catch(() => undefined);
  }
  open.clear();
  await manager.emptyBucket();
}

/**
 * Run `exercise` against a fresh throwaway bucket, then empty and delete it.
 *
 * Everything but the bucket is built *before* the create, so the one thing teardown has to undo is the
 * one thing `create` did. One bucket per test keeps a failure's debris out of the next test — and out
 * of the account.
 */
export async function withLiveBucket<T>(
  creds: IntegrationCreds,
  exercise: (plane: LiveObjectPlane) => Promise<T>,
): Promise<T> {
  const r2 = creds.r2;
  if (!r2) throw new Error("withLiveBucket needs R2_CREDENTIALS — gate the suite on `creds.r2`.");

  const clients = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });
  const provisioner = clients.r2Provisioner();
  const bucketName = uniqueName("storage");
  const manager = clients.r2({ ...r2, bucketName });
  const open = new Map<string, OpenUpload>();
  const store = liveObjectStore(
    { ...r2, accountId: creds.accountId, apiToken: creds.apiToken, bucket: bucketName },
    manager,
    open,
  );

  return withThrowawayResource(
    () => provisioner.createBucket(bucketName),
    () => exercise({ bucketName, store, manager }),
    async () => {
      // A purge failure would only resurface as a bucket-delete failure; let that be the loud one, so a
      // genuine assertion error is never masked by teardown noise.
      await purgeBucket(manager, open).catch(() => undefined);
      await provisioner.deleteBucket(bucketName);
    },
  );
}

/** The storage migrations, composed the way `pithy migrate` composes them for the app database. */
function storageMigrations() {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "storage",
      order: STORAGE_MIGRATION_ORDER,
      migrations: { "0001_objects": storage_0001_objects },
    },
  ]);
  const provider = registry.app;
  if (!provider) throw new Error("no app migration provider");
  return provider;
}

/**
 * Run `exercise` against a fresh throwaway D1, migrated to storage's schema, then delete it.
 *
 * A real database rather than Miniflare's, for one reason: this pool is Node, and Miniflare's D1 lives
 * in workerd. Standing one up here would mean running the sweep against an emulator on one side and
 * real R2 on the other, which is the mixed picture the live suite exists to replace. It also buys a
 * second proof for free — the migration runs on real D1 over REST, exactly as `pithy migrate` runs it.
 */
export async function withLiveDatabase<T>(
  creds: IntegrationCreds,
  exercise: (db: StorageDatabase) => Promise<T>,
): Promise<T> {
  const clients = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });
  const provisioner = clients.d1Provisioner();

  return withThrowawayResource(
    () => provisioner.createDatabase(uniqueName("storage")),
    async (database) => {
      const d1 = clients.d1(database.uuid) as unknown as D1Database;
      await runMigrations(d1, storageMigrations());
      return exercise(storageDatabase(d1));
    },
    (database) => provisioner.deleteDatabase(database.uuid),
  );
}
