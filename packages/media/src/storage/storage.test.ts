// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import { describe, expect, test } from "vitest";
import { MediaConfig } from "../config/config";
import { backendForType, mediaR2Key } from "./backend";
import type { ImageMinter, R2Minter, VideoMinter } from "./minter";
import { mediaStorage } from "./storage";

/** Fake minters recording their calls. */
function fakes() {
  const calls: string[] = [];
  const image: ImageMinter = {
    mintDirectUpload: async () => {
      calls.push("image");
      return { id: "img-1", uploadUrl: "https://images/upload" };
    },
    delete: async (id) => {
      calls.push(`image:delete:${id}`);
    },
  };
  const video: VideoMinter = {
    mintDirectUpload: async () => {
      calls.push("video");
      return { uid: "vid-1", uploadUrl: "https://stream/upload" };
    },
    delete: async (uid) => {
      calls.push(`video:delete:${uid}`);
    },
  };
  const r2: R2Minter = {
    mintUpload: async (key) => {
      calls.push(`r2:${key}`);
      return `https://r2/upload/${key}`;
    },
    mintDownload: async (key) => `https://r2/download/${key}`,
  };
  return { calls, image, video, r2 };
}

const bucket = {
  get: async (key: string) => (key === "hit" ? { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : null),
  delete: async () => {},
} as unknown as R2Bucket;

describe("backendForType / mediaR2Key", () => {
  test("selects the backend per type and honors config overrides", () => {
    const config = MediaConfig.parse({ images: { store: "r2" }, video: { store: "r2" } });
    expect(backendForType("image", config)).toBe("r2");
    expect(backendForType("video", config)).toBe("r2");
    expect(backendForType("audio", MediaConfig.parse({}))).toBe("r2");
    expect(backendForType("document", MediaConfig.parse({}))).toBe("r2");
    expect(backendForType("image", MediaConfig.parse({}))).toBe("cf-images");
    expect(backendForType("video", MediaConfig.parse({}))).toBe("cf-stream");
  });

  test("builds a namespaced R2 key", () => {
    expect(mediaR2Key("audio", "abc")).toBe("media/audio/abc");
  });
});

describe("mediaStorage.mintUpload", () => {
  test("mints to Cloudflare Images for images by default", async () => {
    const { image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    const target = await storage.mintUpload({ type: "image", id: "m1", contentType: "image/png", size: 1 });
    expect(target).toEqual({ uploadUrl: "https://images/upload", storageBackend: "cf-images", storageKey: "img-1" });
  });

  test("mints to Cloudflare Stream for video by default", async () => {
    const { image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    const target = await storage.mintUpload({ type: "video", id: "m1", contentType: "video/mp4", size: 1 });
    expect(target).toEqual({ uploadUrl: "https://stream/upload", storageBackend: "cf-stream", storageKey: "vid-1" });
  });

  test("mints a presigned R2 PUT for audio, keyed media/<type>/<id>", async () => {
    const { image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    const target = await storage.mintUpload({ type: "audio", id: "m1", contentType: "audio/mpeg", size: 10 });
    expect(target.storageBackend).toBe("r2");
    expect(target.storageKey).toBe("media/audio/m1");
    expect(target.uploadUrl).toBe("https://r2/upload/media/audio/m1");
  });

  test("wraps a minter failure as media/storage_failed", async () => {
    const { video, r2 } = fakes();
    const image: ImageMinter = {
      mintDirectUpload: async () => {
        throw new Error("cf down");
      },
      delete: async () => {},
    };
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    await expect(storage.mintUpload({ type: "image", id: "m1", contentType: "image/png" })).rejects.toMatchObject({
      payload: { code: "media/storage_failed" },
    });
  });
});

describe("mediaStorage.deleteObject / readR2Object", () => {
  test("routes delete to the right backend", async () => {
    const { calls, image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    await storage.deleteObject({ storageBackend: "cf-images", storageKey: "img-9" });
    await storage.deleteObject({ storageBackend: "cf-stream", storageKey: "vid-9" });
    expect(calls).toContain("image:delete:img-9");
    expect(calls).toContain("video:delete:vid-9");
  });

  test("readR2Object returns bytes on a hit and throws on a miss", async () => {
    const { image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    expect(Array.from(await storage.readR2Object("hit"))).toEqual([1, 2, 3]);
    await expect(storage.readR2Object("miss")).rejects.toMatchObject({ payload: { code: "media/storage_failed" } });
  });

  test("presignedDownloadUrl signs an R2 key and rejects a non-R2 backend", async () => {
    const { image, video, r2 } = fakes();
    const storage = mediaStorage({ image, video, r2, bucket, config: MediaConfig.parse({}) });
    expect(await storage.presignedDownloadUrl({ storageBackend: "r2", storageKey: "media/audio/x" })).toBe(
      "https://r2/download/media/audio/x",
    );
    await expect(
      storage.presignedDownloadUrl({ storageBackend: "cf-images", storageKey: "img-1" }),
    ).rejects.toMatchObject({ payload: { code: "media/unsupported" } });
  });
});
