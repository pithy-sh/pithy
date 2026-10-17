// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { MediaDelivery } from "../config/config";
import type { MediaRecord } from "../record/store";
import type { DeliverySigner } from "./sign";
import { buildImageUrl, buildStreamHlsUrl, buildStreamThumbnailUrl, deliveryUrl, mediaUrl } from "./url";

function record(
  storageBackend: MediaRecord["storageBackend"],
  storageKey: string,
  overrides: Partial<MediaRecord> = {},
): MediaRecord {
  return {
    id: "m1",
    storageBackend,
    storageKey,
    visibility: "public",
    signedDelivery: false,
    ...overrides,
  } as MediaRecord;
}

describe("URL builders", () => {
  test("buildImageUrl uses imagedelivery.net with the variant", () => {
    expect(buildImageUrl("img-1", "hash", "public")).toBe("https://imagedelivery.net/hash/img-1/public");
    expect(buildImageUrl("img-1", "hash")).toBe("https://imagedelivery.net/hash/img-1/public");
  });

  test("buildStream* use the customer subdomain", () => {
    expect(buildStreamHlsUrl("uid", "abc")).toBe("https://customer-abc.cloudflarestream.com/uid/manifest/video.m3u8");
    expect(buildStreamThumbnailUrl("uid", "abc")).toBe(
      "https://customer-abc.cloudflarestream.com/uid/thumbnails/thumbnail.jpg",
    );
  });
});

describe("mediaUrl — the plain URL of a public record", () => {
  test("dispatches by backend using the delivery config", () => {
    expect(mediaUrl(record("cf-images", "img-1"), { imagesAccountHash: "hash" })).toBe(
      "https://imagedelivery.net/hash/img-1/public",
    );
    expect(mediaUrl(record("cf-stream", "uid"), { streamCustomerCode: "abc" })).toBe(
      "https://customer-abc.cloudflarestream.com/uid/manifest/video.m3u8",
    );
    expect(mediaUrl(record("r2", "media/audio/x"), { r2PublicBaseUrl: "https://cdn.example.com/" })).toBe(
      "https://cdn.example.com/media/audio/x",
    );
  });

  test("throws media/unsupported when the needed delivery identifier is missing", () => {
    expect(() => mediaUrl(record("cf-images", "img-1"), {})).toThrow();
    expect(() => mediaUrl(record("cf-stream", "uid"), {})).toThrow();
    expect(() => mediaUrl(record("r2", "k"), {})).toThrow();
  });

  test("a record whose bytes are signed has no plain URL", () => {
    const signed = record("cf-images", "img-1", { visibility: "private", signedDelivery: true });
    expect(() => mediaUrl(signed, { imagesAccountHash: "hash" })).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "media/unsupported" }) }),
    );
  });

  test("a private R2 record is never reachable through r2PublicBaseUrl", () => {
    const private_ = record("r2", "media/audio/x", { visibility: "private" });
    expect(() => mediaUrl(private_, { r2PublicBaseUrl: "https://cdn.example.com" })).toThrow();
  });
});

describe("deliveryUrl — what a reader is handed", () => {
  const NOW = new Date("2026-10-16T12:00:00.000Z");
  const delivery = MediaDelivery.parse({ imagesAccountHash: "hash", streamCustomerCode: "abc" });
  const signer: DeliverySigner = {
    signImageUrl: async (url, expiresAt) => `${url}?signed=${expiresAt.toISOString()}`,
    streamToken: async (uid) => `token-for-${uid}`,
  };

  function options(overrides: { presign?: (key: string, ttl: number) => Promise<string> } = {}) {
    return {
      delivery,
      signer: vi.fn(async () => signer),
      presign: overrides.presign ?? (async (key: string, ttl: number) => `https://r2/presigned/${key}?ttl=${ttl}`),
      now: () => NOW,
    };
  }

  const EXPIRES = new Date(NOW.getTime() + delivery.signedUrlTtlSeconds * 1000);

  test("a signed image gets a short-lived signed URL", async () => {
    const result = await deliveryUrl(record("cf-images", "img-1", { signedDelivery: true }), options());
    expect(result).toEqual({
      url: `https://imagedelivery.net/hash/img-1/public?signed=${EXPIRES.toISOString()}`,
      expiresAt: EXPIRES,
    });
  });

  test("a public image gets its plain URL, and no signing key is ever read", async () => {
    const opts = options();
    expect(await deliveryUrl(record("cf-images", "img-1"), opts)).toEqual({
      url: "https://imagedelivery.net/hash/img-1/public",
      expiresAt: null,
    });
    expect(opts.signer).not.toHaveBeenCalled();
  });

  test("a signed video's token takes the uid's place in the playback URL", async () => {
    const result = await deliveryUrl(record("cf-stream", "vid-1", { signedDelivery: true }), options());
    expect(result.url).toBe("https://customer-abc.cloudflarestream.com/token-for-vid-1/manifest/video.m3u8");
    expect(result.expiresAt).toEqual(EXPIRES);
  });

  test("URL building reads signedDelivery, not visibility — private but not yet signed is still plain", async () => {
    const pending = record("cf-images", "img-1", { visibility: "private", signedDelivery: false });
    expect((await deliveryUrl(pending, options())).url).toBe("https://imagedelivery.net/hash/img-1/public");
  });

  test("a private R2 record is presigned for the signed lifetime, even with a public base configured", async () => {
    const withBase = MediaDelivery.parse({ r2PublicBaseUrl: "https://cdn.example.com" });
    const result = await deliveryUrl(record("r2", "media/audio/x", { visibility: "private" }), {
      ...options(),
      delivery: withBase,
    });
    expect(result.url).toBe(`https://r2/presigned/media/audio/x?ttl=${withBase.signedUrlTtlSeconds}`);
  });

  test("a public R2 record uses the public base when there is one", async () => {
    const withBase = MediaDelivery.parse({ r2PublicBaseUrl: "https://cdn.example.com" });
    const result = await deliveryUrl(record("r2", "media/audio/x"), { ...options(), delivery: withBase });
    expect(result).toEqual({ url: "https://cdn.example.com/media/audio/x", expiresAt: null });
  });
});
