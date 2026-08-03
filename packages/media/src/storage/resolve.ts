// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { AssetOwner } from "@pithy-sh/cloudflare/src/media/ownership";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { objectStore } from "@pithy-sh/storage/src/object/store";
import type { MediaConfig } from "../config/config";
import { MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "../secret/registry";
import { imageMinter, objectStoreMinter, videoMinter } from "./cloudflare";
import { type MediaStorage, mediaStorage } from "./storage";

/** The env the storage layer reads: the secrets bindings, the `MEDIA_BUCKET` R2 binding, and the owner. */
export type StorageEnv = SecretsStoreEnv & {
  /** The R2 bucket binding media objects are read from and deleted through (bindings-first). */
  MEDIA_BUCKET: R2Bucket;
  /**
   * The project name, stamped into every deployed Worker's vars at provision alongside `ENVIRONMENT`
   * (`resolveWorkflowHost` in `@pithy-sh/core`). It is the owner written into the metadata of every
   * Cloudflare Images and Stream asset this Worker mints — the only isolation those two account-flat
   * stores have, since their assets are keyed by a Cloudflare-minted id rather than by a name we choose.
   */
  PROJECT?: string;
};

/**
 * Who owns the assets this Worker is about to create.
 *
 * `ENVIRONMENT` absent means local dev — the same signal `@pithy-sh/secrets` keys its reader on — so
 * it falls back to `dev`. `PROJECT` has no such fallback and is never guessed: CLAUDE.md §Resource
 * naming forbids it for names anything must reproduce later, and a sweep is exactly that. Cloudflare
 * Images and Stream have no local emulation, so even a `pithy dev` upload writes into the shared,
 * account-wide store — an unstamped asset there is debris nobody can attribute or delete. Refusing to
 * mint is the smaller failure.
 */
export function assetOwner(env: StorageEnv): AssetOwner {
  const project = env.PROJECT?.trim();
  if (!project) {
    throw new InternalError({
      message: "This Worker cannot mint a Cloudflare Images or Stream upload: it does not know its project.",
      action: 'Add "PROJECT" to the Worker\'s wrangler.jsonc vars, set to the root pithy.config.ts name.',
      detail: "media storage env carries no PROJECT var; Images and Stream assets would be unattributable",
    });
  }
  return { project, env: env.ENVIRONMENT ?? "dev" };
}

/**
 * Resolve the storage seam from the request env.
 *
 * Images and Stream are media's own: the scoped CF API token is read once through the shared
 * `@pithy-sh/secrets` accessor (never a raw binding) and the two managers are built from it. Both
 * minters are constructed with {@link assetOwner}, so every asset they mint carries the project and
 * environment that created it.
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
  const owner = assetOwner(env);
  return mediaStorage({
    image: imageMinter(new CloudflareImageManager(clientConfig), owner),
    video: videoMinter(new CloudflareStreamManager(clientConfig), owner),
    r2: objectStoreMinter(objectStore({ bucket: env.MEDIA_BUCKET, env, secretName: MEDIA_R2_SECRET })),
    bucket: env.MEDIA_BUCKET,
    config,
  });
}
