// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import type { CloudflareManagerConfig } from "@pithy-sh/cloudflare/src/client/manager";
import { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { AssetOwner } from "@pithy-sh/cloudflare/src/media/ownership";
import { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { RUNTIME_PROFILE, RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { runtimeTokenRegistry } from "@pithy-sh/secrets/src/tokens/runtimeTokenRegistry";
import { objectStore } from "@pithy-sh/storage/src/object/store";
import type { MediaConfig } from "../config/config";
import {
  MEDIA_R2_SECRET,
  MEDIA_STORAGE_SECRET,
  mediaOwnSecretsRegistry,
  mediaRuntimePermissions,
} from "../secret/registry";
import { imageMinter, objectStoreMinter, videoMinter } from "./cloudflare";
import type { ImageMinter, VideoMinter } from "./minter";
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
 * **How this Worker reaches Cloudflare Images, Stream and their analytics: the application's one runtime
 * token, and the account media's assets live in (#728).** Resolved once per call to the returned function's
 * first use, and never before — so a request that touches only R2 reads no token at all.
 *
 * The token is read through the one secrets reader, from a registry naming exactly what this config needs
 * of it — the same declaration `media()` hangs on its `secretRegistry`. A config storing both types in R2
 * declares no token, so asking for one here is refused by name rather than by the reader's wiring error:
 * the record it was asked for was stored on a product this Worker is no longer configured to use.
 */
export function mediaCloudflareConfig(
  env: SecretsStoreEnv,
  config: Pick<MediaConfig, "images" | "video">,
): () => Promise<CloudflareManagerConfig> {
  let resolved: Promise<CloudflareManagerConfig> | undefined;
  return () => {
    resolved ??= (async () => {
      const needs = mediaRuntimePermissions(config);
      if (needs.length === 0) {
        throw new InternalError({
          message: "This Worker stores no media on Cloudflare Images or Stream, so it holds no token to reach them.",
          action: `Store a type on Cloudflare Images or Stream in media({ … }), then ${commandName("token rotate")} ${RUNTIME_PROFILE} --env <env> so the token carries it.`,
          detail: "media asked for the runtime token under a config that declares none (both stores are r2)",
        });
      }
      const own = await sharedSecretsStore(env, mediaOwnSecretsRegistry);
      const runtime = await sharedSecretsStore(env, runtimeTokenRegistry(needs));
      return { apiToken: runtime.get(RUNTIME_TOKEN_SECRET), accountId: own.get(MEDIA_STORAGE_SECRET).accountId };
    })();
    return resolved;
  };
}

/** An {@link ImageMinter} whose manager is built at its first call, never before. */
function deferredImageMinter(make: () => Promise<ImageMinter>): ImageMinter {
  return {
    mintDirectUpload: async (metadata, options) => (await make()).mintDirectUpload(metadata, options),
    setSigning: async (id, required) => (await make()).setSigning(id, required),
    delete: async (id) => (await make()).delete(id),
  };
}

/** A {@link VideoMinter} whose manager is built at its first call, never before. */
function deferredVideoMinter(make: () => Promise<VideoMinter>): VideoMinter {
  return {
    mintDirectUpload: async (metadata, options) => (await make()).mintDirectUpload(metadata, options),
    setSigning: async (uid, required) => (await make()).setSigning(uid, required),
    delete: async (uid) => (await make()).delete(uid),
  };
}

/**
 * Resolve the storage seam from the request env.
 *
 * Images and Stream are reached with the application's runtime token, through {@link mediaCloudflareConfig},
 * and **only when a call needs one** (#728). Both minters are built with {@link assetOwner}, so every asset
 * they mint carries the project and environment that created it — and that too is asked only then. So a
 * project storing everything in R2 serves every route without reading a Cloudflare token or needing a
 * `PROJECT` var.
 *
 * R2 is not media's. `objectStore` from `@pithy-sh/storage` owns the bucket, the credential, and the S3
 * client; media points it at `MEDIA_BUCKET` under its own secret name and consumes two presign methods
 * through the `R2Minter` port. Nothing here reads an access key. The store resolves that credential
 * **lazily**, so a request that only reads or deletes — both of which stay on the bucket binding — never
 * touches the secrets store at all.
 */
export async function resolveStorage(env: StorageEnv, config: MediaConfig): Promise<MediaStorage> {
  const cloudflare = mediaCloudflareConfig(env, config);
  return mediaStorage({
    image: deferredImageMinter(async () =>
      imageMinter(new CloudflareImageManager(await cloudflare()), assetOwner(env)),
    ),
    video: deferredVideoMinter(async () =>
      videoMinter(new CloudflareStreamManager(await cloudflare()), assetOwner(env)),
    ),
    r2: objectStoreMinter(objectStore({ bucket: env.MEDIA_BUCKET, env, secretName: MEDIA_R2_SECRET })),
    bucket: env.MEDIA_BUCKET,
    config,
  });
}
