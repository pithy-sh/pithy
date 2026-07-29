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

/** Mints a one-time Cloudflare Images direct-upload URL and deletes stored images. */
export interface ImageMinter {
  /** Mint a direct-upload URL; CF assigns the image id, returned as the storage key. */
  mintDirectUpload(metadata?: Record<string, string>): Promise<{ id: string; uploadUrl: string }>;
  /** Delete a stored image by its CF Images id. */
  delete(id: string): Promise<void>;
}

/** Mints a Cloudflare Stream direct-upload URL and deletes stored videos. */
export interface VideoMinter {
  /** Mint a direct-upload URL; CF assigns the video uid, returned as the storage key. */
  mintDirectUpload(): Promise<{ uid: string; uploadUrl: string }>;
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
  /** Presigned GET URL for reading an object back (enrichment reads audio/documents this way). */
  mintDownload(key: string): Promise<string>;
}
