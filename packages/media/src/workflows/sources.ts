// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DeliverySigner } from "../deliver/sign";
import { buildImageUrl } from "../deliver/url";
import { MediaEnrichmentError } from "../error/errors";
import type { MediaRecord } from "../record/store";

/**
 * Where the enrichment worker reads a Cloudflare-hosted record's bytes from. A private record's asset is
 * uploaded with `requireSignedURLs`, so its plain URL answers nobody: the worker signs its own URL, the
 * same way a reader is handed one, or a private image or video would enrich nothing.
 *
 * Kept apart from `worker.ts`, which imports `cloudflare:workers` and runs only in the Workers runtime, so
 * the signing branch is tested directly.
 */

/** How long a URL the worker signs for itself lives: long enough for one fetch, and no longer. */
export const ENRICHMENT_URL_TTL_MS = 5 * 60 * 1000;

/** The record fields the source URL depends on. */
type SourceRecord = Pick<MediaRecord, "storageKey" | "signedDelivery">;

/** The signer, resolved only when a signed record needs it. */
type LazySigner = () => Promise<DeliverySigner>;

/** The Images delivery URL for a record's bytes: signed to expire one TTL from `now` when the bytes are. */
export async function enrichmentImageUrl(
  record: SourceRecord,
  imagesAccountHash: string | undefined,
  signer: LazySigner,
  now: number = Date.now(),
): Promise<string> {
  if (!imagesAccountHash) {
    throw new MediaEnrichmentError({
      detail: "delivery.imagesAccountHash is required to read image bytes for enrichment",
    });
  }
  const plain = buildImageUrl(record.storageKey, imagesAccountHash);
  if (!record.signedDelivery) return plain;
  return (await signer()).signImageUrl(plain, new Date(now + ENRICHMENT_URL_TTL_MS));
}

/**
 * The HLS URL a record's audio is read from. A signed video plays only with a token, which takes the uid's
 * place in its playback URL. A playback URL that does not carry the uid refuses rather than fetching unsigned.
 */
export async function enrichmentPlaylistUrl(
  record: SourceRecord,
  hls: string,
  signer: LazySigner,
  now: number = Date.now(),
): Promise<string> {
  if (!record.signedDelivery) return hls;
  const segment = `/${record.storageKey}/`;
  if (!hls.includes(segment)) {
    throw new MediaEnrichmentError({ detail: `video ${record.storageKey} playback URL does not carry its uid` });
  }
  const token = await (await signer()).streamToken(record.storageKey, new Date(now + ENRICHMENT_URL_TTL_MS));
  return hls.replace(segment, `/${token}/`);
}
