/**
 * The storage minting seams — the clean interfaces the media capability depends on, decoupled from the
 * `@pithy-sh/cloudflare` managers' SDK-typed returns. A test injects a fake minter; the real adapters
 * (over the CF Images, Stream, and R2 managers) live in `storage/cloudflare.ts`, the one file that
 * touches the SDK shapes. Every direct-upload URL is minted through `@pithy-sh/cloudflare` — no
 * hand-rolled `fetch` to the CF API (CLAUDE.md §Cloudflare access).
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

/** Mints presigned R2 (S3) PUT/GET URLs. */
export interface R2Minter {
  /** Presigned PUT URL for a client to upload bytes straight to R2. */
  mintUpload(key: string, contentType: string, contentLength: number): Promise<string>;
  /** Presigned GET URL for reading an object back (enrichment reads audio/documents this way). */
  mintDownload(key: string): Promise<string>;
}
