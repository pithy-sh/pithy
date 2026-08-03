// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareRequestError, cloudflareRequest, decodeResponse } from "../client/errors";
import type { CloudflareImageManager } from "./imageManager";
import { type AssetOwner, withAssetOwnership } from "./ownership";
import type { CloudflareStreamManager } from "./streamManager";

/**
 * Seed-time byte uploads to the account-flat Cloudflare Images and Stream stores. Seeding hands a
 * manager raw bytes and a metadata bag and gets back the minted asset id/uid to record — the one
 * place these two stores accept fixture bytes from a CLI/CI context. Every wire response is
 * validated with a local Zod object so a shape drift fails loudly (`cloudflare/invalid_response`)
 * instead of surfacing as `undefined`. These calls are always remote: neither store has a local
 * emulation, so even a `pithy seed` against dev writes into the same store production shares.
 *
 * Which is why {@link AssetOwner} is **required**, not optional. An asset here is keyed by a
 * Cloudflare-minted id, so its metadata is the only thing that says which project seeded it —
 * see `ownership.ts`. Seed fixtures are the likeliest source of debris, and an unattributable
 * fixture asset is one nobody can sweep.
 */

/** The default max video duration (seconds) CF Stream requires for a direct upload — 6 hours. */
const STREAM_MAX_DURATION_SECONDS = 21600;

/** The only field of an Images upload response the seeder needs: the minted image id. */
const ImageUploadResult = z.object({ id: z.string() });

/** The fields of a Stream direct-upload mint the seeder needs: the uid and the one-time upload URL. */
const StreamDirectUploadResult = z.object({ uid: z.string(), uploadURL: z.string() });

/**
 * Upload image bytes to Cloudflare Images, stamped with the owner, returning the minted id. Images
 * supports a direct byte upload, so this is a single `uploadImage({ file, metadata })` call — the
 * manager JSON-encodes the metadata bag for the wire. The fixture's own metadata rides along; the
 * ownership keys are merged last, so a fixture cannot claim another project's assets.
 */
export async function uploadImageBytes(
  manager: CloudflareImageManager,
  bytes: Uint8Array | Blob,
  opts: { owner: AssetOwner; metadata?: Record<string, string> },
): Promise<{ id: string }> {
  // The Images SDK's `Uploadable` type is a `File`, not a bare `Blob`, so wrap a Blob/bytes input.
  const file = bytes instanceof File ? bytes : new File([bytes], "seed");
  const response = await manager.uploadImage({ file, metadata: withAssetOwnership(opts.owner, opts.metadata) });
  const result = decodeResponse(ImageUploadResult, response, "Images seed upload");
  return { id: result.id };
}

/**
 * Upload video bytes to Cloudflare Stream, returning the minted uid. Stream has no single direct-bytes
 * method, so this mints a one-time upload URL with `createDirectUpload` — carrying the stamped metadata
 * as `meta` so ownership lands with the video — then POSTs the bytes to that URL as `multipart/form-data` (the
 * basic direct-upload contract). Because the mint carries the metadata, no follow-up `updateVideo`
 * stamp is needed; if a future Stream contract dropped mint-time `meta`, stamp with
 * `updateVideo(uid, { meta })` after the upload.
 */
export async function uploadStreamBytes(
  manager: CloudflareStreamManager,
  bytes: Uint8Array | Blob,
  opts: { owner: AssetOwner; metadata?: Record<string, string>; maxDurationSeconds?: number },
): Promise<{ uid: string }> {
  const mint = decodeResponse(
    StreamDirectUploadResult,
    await manager.createDirectUpload({
      maxDurationSeconds: opts.maxDurationSeconds ?? STREAM_MAX_DURATION_SECONDS,
      meta: withAssetOwnership(opts.owner, opts.metadata),
    }),
    "Stream seed direct upload",
  );

  await cloudflareRequest("Stream seed byte upload", async () => {
    const file = bytes instanceof Blob ? bytes : new Blob([bytes]);
    const form = new FormData();
    form.append("file", file, "seed");
    const response = await fetch(mint.uploadURL, { method: "POST", body: form });
    if (!response.ok) {
      throw new CloudflareRequestError({
        message: "The Stream direct upload failed.",
        detail: `Stream direct upload returned ${response.status}: ${await response.text()}`,
      });
    }
  });

  return { uid: mint.uid };
}
