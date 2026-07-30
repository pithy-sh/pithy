// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { objectStore } from "@pithy-sh/storage/src/object/store";
import type { MediaConfig } from "../config/config";
import { MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "../secret/registry";
import { imageMinter, objectStoreMinter, videoMinter } from "./cloudflare";
import { type MediaStorage, mediaStorage } from "./storage";

/** The env the storage layer reads: the secrets bindings plus the `MEDIA_BUCKET` R2 binding. */
export type StorageEnv = SecretsStoreEnv & {
  /** The R2 bucket binding media objects are read from and deleted through (bindings-first). */
  MEDIA_BUCKET: R2Bucket;
};

/**
 * Resolve the storage seam from the request env.
 *
 * Images and Stream are media's own: the scoped CF API token is read once through the shared
 * `@pithy-sh/secrets` accessor (never a raw binding) and the two managers are built from it.
 *
 * R2 is not. `objectStore` from `@pithy-sh/storage` owns the bucket, the credential, and the S3 client;
 * media points it at `MEDIA_BUCKET` under its own secret name and consumes two presign methods through
 * the `R2Minter` port. Nothing here reads an access key. The store resolves that credential
 * **lazily**, so a request that only reads or deletes — both of which stay on the bucket binding —
 * never touches the secrets store at all.
 */
export async function resolveStorage(env: StorageEnv, config: MediaConfig): Promise<MediaStorage> {
  const store = await sharedSecretsStore(env, mediaSecretsRegistry);
  const credentials = store.get(MEDIA_STORAGE_SECRET);
  const clientConfig = { apiToken: credentials.apiToken, accountId: credentials.accountId };
  return mediaStorage({
    image: imageMinter(new CloudflareImageManager(clientConfig)),
    video: videoMinter(new CloudflareStreamManager(clientConfig)),
    r2: objectStoreMinter(objectStore({ bucket: env.MEDIA_BUCKET, env, secretName: MEDIA_R2_SECRET })),
    bucket: env.MEDIA_BUCKET,
    config,
  });
}
