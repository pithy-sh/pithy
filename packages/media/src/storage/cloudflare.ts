import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { z } from "zod";
import type { ImageMinter, R2Minter, VideoMinter } from "./minter";

/**
 * The SDK-friction boundary: adapters that wrap the `@pithy-sh/cloudflare` managers into the clean
 * {@link ImageMinter}/{@link VideoMinter}/{@link R2Minter} seams. This is the only media file that touches
 * the managers' SDK-typed responses; it validates the handful of fields it needs with a local Zod object
 * so an unexpected shape fails loudly rather than surfacing as `undefined`.
 */

/** The default max video duration (seconds) CF Stream requires for a direct upload — 6 hours. */
const STREAM_MAX_DURATION_SECONDS = 21600;

const ImageUploadResponse = z.object({ id: z.string(), uploadURL: z.string() });
const StreamUploadResponse = z.object({ uid: z.string(), uploadURL: z.string() });

/** Adapt a {@link CloudflareImageManager} to the {@link ImageMinter} seam. */
export function imageMinter(manager: CloudflareImageManager): ImageMinter {
  return {
    async mintDirectUpload(metadata) {
      const response = ImageUploadResponse.parse(await manager.createDirectUploadUrl({ metadata }));
      return { id: response.id, uploadUrl: response.uploadURL };
    },
    delete: (id) => manager.deleteImage(id),
  };
}

/** Adapt a {@link CloudflareStreamManager} to the {@link VideoMinter} seam. */
export function videoMinter(manager: CloudflareStreamManager): VideoMinter {
  return {
    async mintDirectUpload() {
      const response = StreamUploadResponse.parse(
        await manager.createDirectUpload({ maxDurationSeconds: STREAM_MAX_DURATION_SECONDS }),
      );
      return { uid: response.uid, uploadUrl: response.uploadURL };
    },
    delete: (uid) => manager.deleteVideo(uid),
  };
}

/** Adapt a {@link CloudflareR2Manager} to the {@link R2Minter} seam. */
export function r2Minter(manager: CloudflareR2Manager): R2Minter {
  return {
    mintUpload: (key, contentType, contentLength) => manager.createUploadUrl(key, contentType, contentLength),
    mintDownload: (key) => manager.createDownloadUrl(key),
  };
}
