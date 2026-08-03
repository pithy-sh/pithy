// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import type { MediaConfig } from "../config/config";
import type { MediaType, StorageBackend } from "../data/enums";
import { MediaStorageError, MediaUnsupportedError } from "../error/errors";
import { backendForType, mediaR2Key } from "./backend";
import type { ImageMinter, R2Minter, VideoMinter } from "./minter";

/** The minters and bucket binding the storage layer needs, plus the resolved config. */
export interface StorageDeps {
  /** Cloudflare Images minter. */
  image: ImageMinter;
  /** Cloudflare Stream minter. */
  video: VideoMinter;
  /** R2 presigned-URL minter. */
  r2: R2Minter;
  /** The R2 bucket binding, for reading and deleting objects (bindings-first). */
  bucket: R2Bucket;
  /** The resolved media config — drives per-type backend selection. */
  config: MediaConfig;
}

/** What an upload needs: the target the client uploads to, and where the bytes will live. */
export interface UploadTarget {
  /** The URL the client uploads the bytes straight to (bytes never proxy through the Worker). */
  uploadUrl: string;
  /** The backend the bytes live in. */
  storageBackend: StorageBackend;
  /** The backend-specific handle: the R2 object key, the CF Images id, or the CF Stream uid. */
  storageKey: string;
}

/** Parameters for minting an upload URL. */
export interface MintParams {
  /** The media type — drives backend selection. */
  type: MediaType;
  /** The record id, used to build a stable R2 key. */
  id: string;
  /** The MIME type, forwarded to the presigned R2 PUT. */
  contentType: string;
  /** The declared size in bytes, forwarded to the presigned R2 PUT; 0 when unknown. */
  size?: number;
  /**
   * Small metadata forwarded to the Cloudflare Images or Stream direct upload — the caller's own keys
   * (identity, album, whatever the adopter tracks). The minters merge the ownership stamp
   * (`pithyProject`/`pithyEnv`) over it, so nothing here can omit or displace it.
   */
  metadata?: Record<string, string>;
}

/** A record's storage coordinates, enough to read or delete its object. */
export interface StorageLocation {
  /** The backend the bytes live in. */
  storageBackend: StorageBackend;
  /** The backend-specific handle. */
  storageKey: string;
}

/** The storage seam the routes and workflows use: mint an upload, read bytes, delete an object. */
export interface MediaStorage {
  /** Mint a direct-upload URL and resolve where the bytes will live. */
  mintUpload(params: MintParams): Promise<UploadTarget>;
  /** Delete a stored object (best-effort cleanup when a record is deleted). */
  deleteObject(location: StorageLocation): Promise<void>;
  /** Read a stored R2 object's bytes (enrichment reads audio/documents through the binding). */
  readR2Object(key: string): Promise<Uint8Array>;
  /**
   * A presigned, time-limited GET URL for a private R2-backed record — the consumer URL for audio and
   * documents (and R2-stored images/video). Throws `media/unsupported` for a Cloudflare Images or Stream
   * record, which have their own delivery URLs (see `deliver/url.ts`).
   */
  presignedDownloadUrl(location: StorageLocation): Promise<string>;
}

/** Build the storage seam over the injected minters, bucket binding, and config. */
export function mediaStorage(deps: StorageDeps): MediaStorage {
  return {
    async mintUpload(params) {
      const backend = backendForType(params.type, deps.config);
      try {
        if (backend === "cf-images") {
          const result = await deps.image.mintDirectUpload(params.metadata);
          return { uploadUrl: result.uploadUrl, storageBackend: "cf-images", storageKey: result.id };
        }
        if (backend === "cf-stream") {
          const result = await deps.video.mintDirectUpload(params.metadata);
          return { uploadUrl: result.uploadUrl, storageBackend: "cf-stream", storageKey: result.uid };
        }
        const key = mediaR2Key(params.type, params.id);
        const uploadUrl = await deps.r2.mintUpload(key, params.contentType, params.size ?? 0);
        return { uploadUrl, storageBackend: "r2", storageKey: key };
      } catch (error) {
        throw new MediaStorageError({ detail: `mint upload failed for ${params.type}` }, { cause: error });
      }
    },

    async deleteObject(location) {
      try {
        if (location.storageBackend === "cf-images") return await deps.image.delete(location.storageKey);
        if (location.storageBackend === "cf-stream") return await deps.video.delete(location.storageKey);
        await deps.bucket.delete(location.storageKey);
      } catch (error) {
        throw new MediaStorageError({ detail: `delete object failed for ${location.storageKey}` }, { cause: error });
      }
    },

    async readR2Object(key) {
      const object = await deps.bucket.get(key);
      if (!object) {
        throw new MediaStorageError({ detail: `R2 object not found: ${key}` });
      }
      return new Uint8Array(await object.arrayBuffer());
    },

    async presignedDownloadUrl(location) {
      if (location.storageBackend !== "r2") {
        throw new MediaUnsupportedError({
          detail: `presignedDownloadUrl is R2-only; ${location.storageBackend} has its own delivery URL`,
        });
      }
      try {
        return await deps.r2.mintDownload(location.storageKey);
      } catch (error) {
        throw new MediaStorageError({ detail: `presign download failed for ${location.storageKey}` }, { cause: error });
      }
    },
  };
}
