// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ConflictError, InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { buildAssetMetadata } from "@pithy-sh/core/src/seed/metadata";
import type { MediaSeedItem } from "@pithy-sh/core/src/seed/seed";
import { z } from "zod";
import { writeFileAtomic } from "../project/atomic";
import { readOptionalFile } from "../project/readOptionalFile";

/**
 * The filesystem side of media seeding — the only part of `pithy seed` that reads fixture bytes and
 * writes a minted UUID back. Core defines the {@link MediaSeedItem} type; this module reads the item's
 * bytes and its `ref` sidecar, uploads through an injected {@link MediaUploader}, and (for a `once`
 * asset) records the minted id atomically so later runs skip the upload.
 *
 * Both the filesystem and the uploader are injectable seams so the orchestrator's tests drive the
 * once/always/idempotent logic against a temp sidecar and a fake minter, with no live account.
 */

/** The `ref` sidecar's shape: the minted asset UUID, recorded after a `once` upload. */
const MediaRef = z
  .object({
    /** The minted Images id or Stream uid, recorded so a later run references it instead of re-uploading. */
    id: z.string().describe("The minted asset UUID (Images id or Stream uid) recorded by the first run."),
  })
  .partial()
  .describe("The JSON sidecar a `once` media seed writes to record its minted asset UUID.");
type MediaRef = z.output<typeof MediaRef>;

/**
 * The byte uploads media seeding needs, one per shared store. Injectable so tests substitute a fake
 * minter; the default (built by the orchestrator from the driver's managers) wraps the
 * `@pithy-sh/cloudflare` seed helpers. Each returns the minted id to record — Stream's `uid` is
 * normalized to `id` so the sidecar shape is one field for both stores.
 */
export interface MediaUploader {
  /** Upload image bytes with the given metadata; resolve the minted Images id. */
  images(bytes: Uint8Array, metadata: Record<string, string>): Promise<{ id: string }>;
  /** Upload video bytes with the given metadata; resolve the minted Stream uid (as `id`). */
  stream(bytes: Uint8Array, metadata: Record<string, string>): Promise<{ id: string }>;
}

/**
 * The filesystem operations media seeding performs. Injectable so tests supply an in-memory fake and
 * assert the write-back without touching disk; the default {@link nodeMediaFs} uses `node:fs`.
 */
export interface MediaFs {
  /** Read a fixture's bytes. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Read the sidecar's text, or `null` when it does not exist yet (a never-uploaded `once` asset). */
  readText(path: string): Promise<string | null>;
  /** Write the sidecar's text atomically, so a crash never leaves a torn file. */
  writeTextAtomic(path: string, text: string): Promise<void>;
}

/**
 * The default {@link MediaFs}: `node:fs`, with the sidecar written through {@link writeFileAtomic}.
 *
 * It used to roll its own temp-file-plus-rename — a UUID name, a plain `writeFile`, a `rename` — and so
 * got none of what the primitive does: no exclusive create, so anything already at the temp path was
 * written through rather than refused; no ownership check on the links it followed, so a planted symlink
 * decided where the write landed; no mode; and no sweep of the file a killed run leaves behind. The
 * payload here is an asset-id sidecar rather than a credential, which changes what it costs, not whether
 * it is the same shape. One writer, one place to get it wrong.
 */
export const nodeMediaFs: MediaFs = {
  readBytes: (path) => readFile(path),
  readText: (path) =>
    // A missing sidecar is the expected first-run state — not an error. Anything else refuses, and which
    // errno is which is {@link readOptionalFile}'s decision rather than this module's: a sidecar that is
    // there and will not open reading as "never uploaded" means `writeTextAtomic` renames a fresh id over
    // the one recorded in it. It used to rethrow node's own error, which reached an adopter as a bare
    // errno and a stack from the middle of a seed run (#203); the sentence below is what it says now.
    readOptionalFile(path, {
      unreadable: ({ code, cause }) =>
        new ConflictError(
          {
            message: `Can't read the media sidecar ${path}.`,
            action: "Fix the file's permissions, or move it aside, and run pithy seed again.",
            detail: `${code ?? "unknown error"} while reading ${path}`,
          },
          { cause },
        ),
    }),
  writeTextAtomic: (path, text) => writeFileAtomic(path, text),
};

/** What seeding one media item did this run — the same shape a dry-run plan reports per asset. */
export interface SeedMediaResult {
  /** The shared asset store the item targeted. */
  store: MediaSeedItem["store"];
  /** The item's upload policy. */
  mode: MediaSeedItem["mode"];
  /** What this run did: `upload` (first `once`), `skip` (recorded `once`), or `reupload` (`always`). */
  action: "upload" | "skip" | "reupload";
  /** The minted (or recorded) asset UUID, when there is one — absent only on a dry-run first `once`. */
  id?: string;
}

/** Options for {@link seedMediaItem}. */
export interface SeedMediaOptions {
  /** The environment being seeded — stamped into the standard asset-metadata block on upload. */
  env: string;
  /**
   * The directory `file`/`ref` are resolved against when they are not absolute — the set's own
   * `baseDir` (the seed module directory), or the project root when the set declares none.
   */
  baseDir: string;
  /** The byte uploader. Required for a real run; omitted for a dry-run (which never uploads). */
  uploader?: MediaUploader;
  /** The filesystem seam. Defaults to {@link nodeMediaFs}. */
  fs?: MediaFs;
  /** Plan only: resolve the action from the sidecar without reading bytes, uploading, or writing back. */
  dryRun?: boolean;
}

/** Resolve a fixture path: absolute paths pass through, relative paths join the base directory. */
function resolvePath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}

/** Read the recorded UUID from a sidecar, or `undefined` when none is recorded (or the file is absent). */
async function readRecordedId(fs: MediaFs, refPath: string): Promise<string | undefined> {
  const text = await fs.readText(refPath);
  if (text === null || text.trim() === "") return undefined;
  let parsed: MediaRef;
  try {
    parsed = MediaRef.parse(JSON.parse(text));
  } catch {
    throw new ValidationError({
      message: `The media sidecar "${refPath}" is not a valid ref file.`,
      action: 'Delete the sidecar to re-mint the asset, or restore it to a { "id": "…" } JSON object.',
    });
  }
  return parsed.id;
}

/** Upload the item's bytes through the store's uploader, or fail loudly if no uploader was provided. */
async function upload(
  item: MediaSeedItem,
  bytes: Uint8Array,
  metadata: Record<string, string>,
  uploader?: MediaUploader,
): Promise<string> {
  if (!uploader) {
    throw new InternalError({ detail: `Media upload attempted for "${item.file}" without a configured uploader.` });
  }
  const result =
    item.store === "images" ? await uploader.images(bytes, metadata) : await uploader.stream(bytes, metadata);
  return result.id;
}

/**
 * Seed one media item into the shared Images/Stream store, idempotently.
 *
 * `once` (the default) uploads only the first time: if the `ref` sidecar already records a UUID the
 * upload is skipped and the recorded id is returned; otherwise the bytes are uploaded with the
 * standard asset-metadata block (built by the caller) and the minted UUID is written back to the
 * sidecar **atomically**, so a later run skips it. `always` re-uploads every run, scoped by metadata,
 * and never writes a UUID back. A `dryRun` resolves the action from the sidecar alone — it reads no
 * bytes, uploads nothing, and writes nothing.
 */
export async function seedMediaItem(item: MediaSeedItem, options: SeedMediaOptions): Promise<SeedMediaResult> {
  const fs = options.fs ?? nodeMediaFs;
  const refPath = resolvePath(options.baseDir, item.ref);
  const filePath = resolvePath(options.baseDir, item.file);

  if (item.mode === "once") {
    const recorded = await readRecordedId(fs, refPath);
    if (recorded !== undefined) return { store: item.store, mode: item.mode, action: "skip", id: recorded };
    if (options.dryRun) return { store: item.store, mode: item.mode, action: "upload" };

    const metadata = buildAssetMetadata(options.env, item.metadata);
    const id = await upload(item, await fs.readBytes(filePath), metadata, options.uploader);
    await fs.writeTextAtomic(refPath, `${JSON.stringify({ id }, null, 2)}\n`);
    return { store: item.store, mode: item.mode, action: "upload", id };
  }

  // `always`: re-upload every run, scoped by metadata, and never record a UUID.
  if (options.dryRun) return { store: item.store, mode: item.mode, action: "reupload" };
  const metadata = buildAssetMetadata(options.env, item.metadata);
  const id = await upload(item, await fs.readBytes(filePath), metadata, options.uploader);
  return { store: item.store, mode: item.mode, action: "reupload", id };
}
