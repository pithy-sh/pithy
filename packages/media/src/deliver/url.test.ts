import { describe, expect, test } from "vitest";
import type { MediaRecord } from "../record/store";
import { buildImageUrl, buildStreamHlsUrl, buildStreamThumbnailUrl, mediaUrl } from "./url";

function record(storageBackend: MediaRecord["storageBackend"], storageKey: string): MediaRecord {
  return { storageBackend, storageKey } as MediaRecord;
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

describe("mediaUrl", () => {
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
    // cf-images without an account hash, and r2 without a public base, both throw (use a presigned URL for r2).
    expect(() => mediaUrl(record("cf-images", "img-1"), {})).toThrow();
    expect(() => mediaUrl(record("cf-stream", "uid"), {})).toThrow();
    expect(() => mediaUrl(record("r2", "k"), {})).toThrow();
  });
});
