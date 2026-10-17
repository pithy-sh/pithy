// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MediaDelivery } from "../config/config";
import { MediaUnsupportedError } from "../error/errors";
import type { MediaRecord } from "../record/store";
import type { DeliverySigner } from "./sign";

/**
 * Consumer URL builders — how an app turns a stored media record into a URL its clients can load. The URL
 * differs by backend: Cloudflare Images serves from `imagedelivery.net` with named variants, Cloudflare
 * Stream serves HLS/DASH/thumbnails from a per-account subdomain, and R2 is either a public base URL or a
 * presigned download. The account identifiers come from the public `delivery` config; a non-public asset
 * is delivered through a short-lived signed URL ({@link deliveryUrl}, `sign.ts`).
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

/** The public identifiers a delivery URL is built from — the non-secret half of `delivery` config. */
export type DeliveryIdentifiers = Pick<MediaDelivery, "imagesAccountHash" | "streamCustomerCode" | "r2PublicBaseUrl">;

/** Throw `media/unsupported` when the delivery config lacks the identifier a backend needs. */
function required(value: string | undefined, field: string, what: string): string {
  if (value) return value;
  throw new MediaUnsupportedError({ detail: `delivery.${field} is required to build ${what}` });
}

/**
 * Build the plain consumer URL for a **public** record from the public delivery config. Synchronous for
 * Cloudflare Images (a named variant, default `public`) and Cloudflare Stream (HLS by default). For an
 * R2-backed record it returns the public base URL join when `r2PublicBaseUrl` is set.
 *
 * **A record whose bytes are signed has no plain URL.** Cloudflare answers nobody at it, so this refuses
 * rather than hand back a link that 403s; ask `GET /media/:id/url`, which signs one for a caller who may
 * read the record. A non-public R2 record is refused the public base for the same reason the config
 * refuses the pairing: a public bucket serves every key in it.
 *
 * Throws `media/unsupported` when the delivery config lacks the identifier the backend needs, so a
 * misconfiguration surfaces clearly instead of producing a broken URL.
 */
export function mediaUrl(
  record: MediaRecord,
  delivery: DeliveryIdentifiers,
  options: { imageVariant?: string } = {},
): string {
  if (record.storageBackend !== "r2" && record.signedDelivery) {
    throw new MediaUnsupportedError({
      detail: `media ${record.id} is served only through signed URLs; mint one with GET /media/:id/url`,
    });
  }
  switch (record.storageBackend) {
    case "cf-images":
      return buildImageUrl(
        record.storageKey,
        required(delivery.imagesAccountHash, "imagesAccountHash", "an image URL"),
        options.imageVariant ?? "public",
      );
    case "cf-stream":
      return buildStreamHlsUrl(
        record.storageKey,
        required(delivery.streamCustomerCode, "streamCustomerCode", "a video URL"),
      );
    case "r2": {
      if (record.visibility !== "public") {
        throw new MediaUnsupportedError({
          detail: `media ${record.id} is ${record.visibility}; a private R2 object is read through a presigned URL, never the public base`,
        });
      }
      const base = required(
        delivery.r2PublicBaseUrl,
        "r2PublicBaseUrl",
        "a public R2 URL; use storage.presignedDownloadUrl(record) for a private one",
      ).replace(/\/$/, "");
      return `${base}/${record.storageKey}`;
    }
  }
}

/** What {@link deliveryUrl} needs beyond the record. */
export interface DeliveryUrlOptions {
  /** The resolved delivery config: identifiers and the signed URL lifetime. */
  readonly delivery: MediaDelivery;
  /** The signer, resolved lazily — a public record never reads a signing key. */
  readonly signer: () => Promise<DeliverySigner>;
  /** Presign an R2 GET for this many seconds. */
  readonly presign: (key: string, expiresInSeconds: number) => Promise<string>;
  /** The current time. */
  readonly now: () => Date;
  /** The Images variant to deliver. Defaults to `public`. */
  readonly imageVariant?: string;
}

/** A delivery URL, and when it stops working — `null` for a plain URL that does not expire. */
export interface DeliveryUrl {
  readonly url: string;
  readonly expiresAt: Date | null;
}

/**
 * The URL a caller who may read a record is handed for its bytes.
 *
 * **It reads `signedDelivery`, never `visibility`.** `visibility` is the owner's intent and one database
 * write; whether Cloudflare refuses a plain request is a setting on Cloudflare's copy, recorded only once
 * Cloudflare confirmed it. So a record that is private but not yet signed — a change that failed halfway,
 * or an existing record the migration made private — gets the plain URL that still works, and a record
 * whose bytes are signed gets a signed one, whatever the visibility column says.
 *
 * An R2 record is public through `r2PublicBaseUrl` only when it is public; otherwise it is a presigned GET
 * of the same lifetime as a signed Cloudflare URL.
 */
export async function deliveryUrl(record: MediaRecord, options: DeliveryUrlOptions): Promise<DeliveryUrl> {
  const { delivery } = options;
  const expiresAt = new Date(options.now().getTime() + delivery.signedUrlTtlSeconds * 1000);
  switch (record.storageBackend) {
    case "cf-images": {
      const url = buildImageUrl(
        record.storageKey,
        required(delivery.imagesAccountHash, "imagesAccountHash", "an image URL"),
        options.imageVariant ?? "public",
      );
      if (!record.signedDelivery) return { url, expiresAt: null };
      return { url: await (await options.signer()).signImageUrl(url, expiresAt), expiresAt };
    }
    case "cf-stream": {
      const code = required(delivery.streamCustomerCode, "streamCustomerCode", "a video URL");
      if (!record.signedDelivery) return { url: buildStreamHlsUrl(record.storageKey, code), expiresAt: null };
      const token = await (await options.signer()).streamToken(record.storageKey, expiresAt);
      return { url: buildStreamHlsUrl(token, code), expiresAt };
    }
    case "r2": {
      if (record.visibility === "public" && delivery.r2PublicBaseUrl) {
        return { url: mediaUrl(record, delivery), expiresAt: null };
      }
      return { url: await options.presign(record.storageKey, delivery.signedUrlTtlSeconds), expiresAt };
    }
  }
}
