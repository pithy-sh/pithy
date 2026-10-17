// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import { type AssetOwner, withAssetOwnership } from "@pithy-sh/cloudflare/src/media/ownership";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { ObjectStore } from "@pithy-sh/storage/src/object/store";
import { z } from "zod";
import type { ImageMinter, R2Minter, VideoMinter } from "./minter";

/**
 * The adapters that fill the {@link ImageMinter}/{@link VideoMinter}/{@link R2Minter} seams.
 *
 * Images and Stream are the SDK-friction boundary: this is the only media file that touches the
 * `@pithy-sh/cloudflare` managers' SDK-typed responses, and it validates the handful of fields it needs
 * with a local Zod object so an unexpected shape fails loudly rather than surfacing as `undefined`.
 *
 * They are also the one boundary where a **name** cannot isolate a project. An R2 key lives inside a
 * bucket already called `<project>-<env>-media`; an Images id and a Stream uid are minted by
 * Cloudflare into one account-flat store. So both minters take an {@link AssetOwner} at construction
 * and stamp it into every asset they create — `withAssetOwnership` merges it **over** the caller's bag,
 * so a caller can neither omit nor overwrite it.
 *
 * R2 is not adapted from an SDK at all. It comes from `@pithy-sh/storage`'s {@link ObjectStore} — the
 * object-plane seam built to be pointed at a second bucket under a second credential name. Media holds
 * no `CloudflareR2Manager`, no key pair, and no bucket name; it holds a store it asks for two URLs.
 */

/** The default max video duration (seconds) CF Stream requires for a direct upload — 6 hours. */
const STREAM_MAX_DURATION_SECONDS = 21600;

const ImageUploadResponse = z.object({ id: z.string(), uploadURL: z.string() });
const StreamUploadResponse = z.object({ uid: z.string(), uploadURL: z.string() });

/** Adapt a {@link CloudflareImageManager} to the {@link ImageMinter} seam, stamped for one owner. */
export function imageMinter(manager: CloudflareImageManager, owner: AssetOwner): ImageMinter {
  return {
    async mintDirectUpload(metadata, options = {}) {
      const response = ImageUploadResponse.parse(
        await manager.createDirectUploadUrl({
          metadata: withAssetOwnership(owner, metadata),
          ...(options.requireSignedURLs ? { requireSignedURLs: true } : {}),
        }),
      );
      return { id: response.id, uploadUrl: response.uploadURL };
    },
    async setSigning(id, required) {
      await manager.updateImage(id, { requireSignedURLs: required });
    },
    delete: (id) => manager.deleteImage(id),
  };
}

/** Adapt a {@link CloudflareStreamManager} to the {@link VideoMinter} seam, stamped for one owner. */
export function videoMinter(manager: CloudflareStreamManager, owner: AssetOwner): VideoMinter {
  return {
    async mintDirectUpload(metadata, options = {}) {
      const response = StreamUploadResponse.parse(
        await manager.createDirectUpload({
          maxDurationSeconds: STREAM_MAX_DURATION_SECONDS,
          meta: withAssetOwnership(owner, metadata),
          ...(options.requireSignedURLs ? { requireSignedURLs: true } : {}),
        }),
      );
      return { uid: response.uid, uploadUrl: response.uploadURL };
    },
    async setSigning(uid, required) {
      await manager.updateVideo(uid, { requireSignedURLs: required });
    },
    delete: (uid) => manager.deleteVideo(uid),
  };
}

/**
 * Adapt an {@link ObjectStore} to the {@link R2Minter} seam — the whole of media's R2 wiring.
 *
 * Only the presign paths cross here. `deleteObject` and `readR2Object` stay on the `R2Bucket` binding
 * in `storage.ts`: a binding read needs no credential, makes no round trip to resolve one, and streams
 * its body, so routing it through the store would cost something and buy nothing. An upload takes the
 * store's default expiry (one hour); a download may name its own, which a reader's delivery URL does.
 */
export function objectStoreMinter(store: ObjectStore): R2Minter {
  return {
    mintUpload: (key, contentType, contentLength) => store.presignPut(key, contentType, contentLength),
    mintDownload: (key, expiresInSeconds) =>
      store.presignGet(key, expiresInSeconds === undefined ? undefined : { expiresIn: expiresInSeconds }),
  };
}
