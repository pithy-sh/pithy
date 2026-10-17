// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The storage minting seams — the clean interfaces the media capability depends on. A test injects a
 * fake minter; the real adapters live in `storage/cloudflare.ts`.
 *
 * {@link ImageMinter} and {@link VideoMinter} are adapted from the `@pithy-sh/cloudflare` managers,
 * decoupled from those managers' SDK-typed returns. Every direct-upload URL is minted through that
 * client — no hand-rolled `fetch` to the CF API (CLAUDE.md §Cloudflare access).
 *
 * {@link R2Minter} is different in kind, and deliberately so: it is not an SDK adapter but the narrow
 * two-method slice of `@pithy-sh/storage`'s `ObjectStore` that media consumes. Media owns no R2
 * mechanism — no bucket, no credential, no S3 client. Stating that slice as its own interface is what
 * keeps `mediaStorage` testable with two async functions instead of a fifteen-method seam, and what
 * lets the object plane change shape without reaching into media.
 */

/**
 * How a direct upload is minted. `requireSignedURLs` makes Cloudflare refuse to serve the bytes to
 * anyone without a signed URL — set for every non-public record, at the moment the upload is minted, so
 * there is never an interval in which a private asset is served plain.
 */
export interface MintOptions {
  /** Serve this asset only through signed URLs. */
  requireSignedURLs?: boolean;
}

/** Mints a one-time Cloudflare Images direct-upload URL, changes an image's signing, and deletes images. */
export interface ImageMinter {
  /**
   * Mint a direct-upload URL; CF assigns the image id, returned as the storage key.
   *
   * The bag is the caller's own; the adapter merges the ownership keys over it, so what reaches
   * Cloudflare always names the owning project and environment (see `cloudflare.ts`).
   */
  mintDirectUpload(
    metadata?: Record<string, string>,
    options?: MintOptions,
  ): Promise<{ id: string; uploadUrl: string }>;
  /** Require, or stop requiring, signed URLs for a stored image. Resolves once Cloudflare confirms. */
  setSigning(id: string, required: boolean): Promise<void>;
  /** Delete a stored image by its CF Images id. */
  delete(id: string): Promise<void>;
}

/** Mints a Cloudflare Stream direct-upload URL, changes a video's signing, and deletes videos. */
export interface VideoMinter {
  /**
   * Mint a direct-upload URL; CF assigns the video uid, returned as the storage key.
   *
   * Takes the same metadata bag as {@link ImageMinter} and for the same reason: Stream is
   * account-flat and keys a video by a Cloudflare-minted uid, so the `meta` object the mint carries
   * is the only place ownership can live. The adapter merges the project and environment over
   * whatever the caller passes.
   */
  mintDirectUpload(
    metadata?: Record<string, string>,
    options?: MintOptions,
  ): Promise<{ uid: string; uploadUrl: string }>;
  /** Require, or stop requiring, signed playback for a stored video. Resolves once Cloudflare confirms. */
  setSigning(uid: string, required: boolean): Promise<void>;
  /** Delete a stored video by its CF Stream uid. */
  delete(uid: string): Promise<void>;
}

/**
 * The presign contract media consumes from `@pithy-sh/storage`'s `ObjectStore`. Two methods, because
 * two are all media needs: reads and deletes go through the `R2Bucket` binding instead, which costs no
 * credential and no round trip (CLAUDE.md §Cloudflare access — bindings inside the Worker, S3 outside).
 */
export interface R2Minter {
  /** Presigned PUT URL for a client to upload bytes straight to R2. */
  mintUpload(key: string, contentType: string, contentLength: number): Promise<string>;
  /**
   * Presigned GET URL for reading an object back — a reader's delivery URL for a private R2 record, and
   * how enrichment reads audio and documents. `expiresInSeconds` defaults to the store's hour.
   */
  mintDownload(key: string, expiresInSeconds?: number): Promise<string>;
}
