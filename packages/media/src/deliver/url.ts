// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MediaDelivery } from "../config/config";
import { MediaUnsupportedError } from "../error/errors";
import type { MediaRecord } from "../record/store";

/**
 * Consumer URL builders — how an app turns a stored media record into a URL its clients can load. The URL
 * differs by backend: Cloudflare Images serves from `imagedelivery.net` with named variants, Cloudflare
 * Stream serves HLS/DASH/thumbnails from a per-account subdomain, and R2 is either a public base URL or a
 * presigned download (async — see {@link MediaStorage.presignedDownloadUrl}). The account identifiers come
 * from the public `delivery` config.
 */

/** Build a Cloudflare Images delivery URL: `https://imagedelivery.net/<hash>/<imageId>/<variant>`. */
export function buildImageUrl(imageId: string, accountHash: string, variant = "public"): string {
  return `https://imagedelivery.net/${accountHash}/${imageId}/${variant}`;
}

/** Build a Cloudflare Stream HLS manifest URL for a video uid. */
export function buildStreamHlsUrl(uid: string, customerCode: string): string {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/manifest/video.m3u8`;
}

/** Build a Cloudflare Stream DASH manifest URL for a video uid. */
export function buildStreamDashUrl(uid: string, customerCode: string): string {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/manifest/video.mpd`;
}

/** Build a Cloudflare Stream still-thumbnail URL for a video uid. */
export function buildStreamThumbnailUrl(uid: string, customerCode: string): string {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`;
}

/** Build a Cloudflare Stream embed/iframe URL for a video uid. */
export function buildStreamIframeUrl(uid: string, customerCode: string): string {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/iframe`;
}

/**
 * Build the consumer URL for a record from the public delivery config. Synchronous for Cloudflare Images
 * (a named variant, default `public`) and Cloudflare Stream (HLS by default). For an R2-backed record it
 * returns the public base URL join when `r2PublicBaseUrl` is set; otherwise it throws — a private R2
 * object needs a presigned download URL, which is async (`storage.presignedDownloadUrl(record)`).
 *
 * Throws `media/unsupported` when the delivery config lacks the identifier the backend needs, so a
 * misconfiguration surfaces clearly instead of producing a broken URL.
 */
export function mediaUrl(
  record: MediaRecord,
  delivery: MediaDelivery,
  options: { imageVariant?: string } = {},
): string {
  switch (record.storageBackend) {
    case "cf-images": {
      if (!delivery.imagesAccountHash) {
        throw new MediaUnsupportedError({ detail: "delivery.imagesAccountHash is required to build an image URL" });
      }
      return buildImageUrl(record.storageKey, delivery.imagesAccountHash, options.imageVariant ?? "public");
    }
    case "cf-stream": {
      if (!delivery.streamCustomerCode) {
        throw new MediaUnsupportedError({ detail: "delivery.streamCustomerCode is required to build a video URL" });
      }
      return buildStreamHlsUrl(record.storageKey, delivery.streamCustomerCode);
    }
    case "r2": {
      if (!delivery.r2PublicBaseUrl) {
        throw new MediaUnsupportedError({
          detail: "delivery.r2PublicBaseUrl is unset; use storage.presignedDownloadUrl(record) for a private R2 object",
        });
      }
      const base = delivery.r2PublicBaseUrl.replace(/\/$/, "");
      return `${base}/${record.storageKey}`;
    }
  }
}
