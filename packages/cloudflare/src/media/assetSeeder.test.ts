// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImageBytes, uploadStreamBytes } from "./assetSeeder";
import type { CloudflareImageManager } from "./imageManager";
import type { CloudflareStreamManager } from "./streamManager";

const uploadImage = vi.fn();
const createDirectUpload = vi.fn();
const updateVideo = vi.fn();

// Faked managers — no live CF account. The seeder only touches these three methods, so a plain
// object cast to the manager type is enough to assert the calls, metadata plumbing, and validation.
const imageManager = { uploadImage } as unknown as CloudflareImageManager;
const streamManager = { createDirectUpload, updateVideo } as unknown as CloudflareStreamManager;

describe("uploadImageBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uploads bytes with metadata and returns the minted id", async () => {
    uploadImage.mockResolvedValue({ id: "img-1", uploadURL: "https://ignored" });
    const result = await uploadImageBytes(imageManager, new Uint8Array([1, 2, 3]), {
      metadata: { pithyEnv: "dev" },
    });

    expect(result).toEqual({ id: "img-1" });
    expect(uploadImage).toHaveBeenCalledWith({ file: expect.any(File), metadata: { pithyEnv: "dev" } });
  });

  it("wraps a Blob input into an uploadable File and omits metadata when none is given", async () => {
    uploadImage.mockResolvedValue({ id: "img-2" });
    await uploadImageBytes(imageManager, new Blob([new Uint8Array([9])]));

    expect(uploadImage).toHaveBeenCalledWith({ file: expect.any(File), metadata: undefined });
  });

  it("throws cloudflare/invalid_response when the response carries no id", async () => {
    uploadImage.mockResolvedValue({ uploadURL: "https://x" });
    await expect(uploadImageBytes(imageManager, new Uint8Array([1]))).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
    );
  });
});

describe("uploadStreamBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints a direct upload carrying metadata, uploads the bytes, and returns the uid", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-1", uploadURL: "https://up.example.com" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadStreamBytes(streamManager, new Uint8Array([1, 2]), {
      metadata: { pithyEnv: "dev" },
      maxDurationSeconds: 300,
    });

    expect(result).toEqual({ uid: "vid-1" });
    expect(createDirectUpload).toHaveBeenCalledWith({ maxDurationSeconds: 300, meta: { pithyEnv: "dev" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://up.example.com",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });

  it("defaults maxDurationSeconds and omits meta when no metadata is given", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-2", uploadURL: "https://up" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }));

    await uploadStreamBytes(streamManager, new Uint8Array([1]));

    expect(createDirectUpload).toHaveBeenCalledWith({ maxDurationSeconds: 21600, meta: undefined });
  });

  it("carries metadata on the mint, so it never stamps via updateVideo", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-5", uploadURL: "https://up" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }));

    await uploadStreamBytes(streamManager, new Uint8Array([1]), { metadata: { pithyEnv: "dev" } });

    expect(updateVideo).not.toHaveBeenCalled();
  });

  it("throws cloudflare/invalid_response when the mint lacks a uid or uploadURL", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-3" });
    await expect(uploadStreamBytes(streamManager, new Uint8Array([1]))).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
    );
  });

  it("throws cloudflare/request_failed when the byte upload is rejected", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-4", uploadURL: "https://up" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));

    await expect(uploadStreamBytes(streamManager, new Uint8Array([1]))).rejects.toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
    );
  });

  it("only ever throws PithyError from a failed byte upload", async () => {
    createDirectUpload.mockResolvedValue({ uid: "vid-6", uploadURL: "https://up" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("a bare string, not an Error"));

    await expect(uploadStreamBytes(streamManager, new Uint8Array([1]))).rejects.toBeInstanceOf(PithyError);
  });
});
