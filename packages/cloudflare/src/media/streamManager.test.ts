// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareStreamManager, DownloadEntry, StreamDownloadStatus } from "./streamManager";

const mockDelete = vi.fn();
const mockGet = vi.fn();
const mockEdit = vi.fn();
const mockList = vi.fn();
const mockDownloadsGet = vi.fn();
const mockDownloadsCreate = vi.fn();
const mockDirectUploadCreate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    stream = {
      delete: mockDelete,
      get: mockGet,
      edit: mockEdit,
      list: mockList,
      downloads: { get: mockDownloadsGet, create: mockDownloadsCreate },
      directUpload: { create: mockDirectUploadCreate },
    };
  },
}));

const opts = { maxRetries: 3, timeout: 10000 };

describe("CloudflareStreamManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareStreamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareStreamManager(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("constructor and info", () => {
    it("reports its service type", () => {
      expect(manager.getServiceType()).toBe("Cloudflare Stream");
    });
  });

  describe("deleteVideo", () => {
    it("calls stream.delete", async () => {
      mockDelete.mockResolvedValue(undefined);
      await manager.deleteVideo("vid-1");
      expect(mockDelete).toHaveBeenCalledWith("vid-1", { account_id: "acct-1" }, opts);
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockDelete.mockRejectedValue(new Error("not found"));
      await expect(manager.deleteVideo("vid-1")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "not found" }),
        }),
      );
    });
  });

  describe("getVideoDetails", () => {
    it("calls stream.get and returns the video", async () => {
      const video = { uid: "vid-1", readyToStream: true };
      mockGet.mockResolvedValue(video);
      expect(await manager.getVideoDetails("vid-1")).toEqual(video);
      expect(mockGet).toHaveBeenCalledWith("vid-1", { account_id: "acct-1" }, opts);
    });
  });

  describe("updateVideo", () => {
    it("calls stream.edit with merged params", async () => {
      const video = { uid: "vid-1", meta: { name: "updated" } };
      mockEdit.mockResolvedValue(video);
      const params = { meta: { name: "updated" } };
      expect(await manager.updateVideo("vid-1", params)).toEqual(video);
      expect(mockEdit).toHaveBeenCalledWith("vid-1", { account_id: "acct-1", ...params }, opts);
    });
  });

  describe("videoDownloadStatus", () => {
    it("validates and returns the download status", async () => {
      const status = { default: { status: "ready", url: "https://dl.example.com", percentComplete: 100 } };
      mockDownloadsGet.mockResolvedValue(status);
      const result = await manager.videoDownloadStatus("vid-1");
      expect(result.default.status).toBe("ready");
      expect(mockDownloadsGet).toHaveBeenCalledWith("vid-1", { account_id: "acct-1" }, opts);
    });

    it("throws cloudflare/invalid_response when the shape is wrong", async () => {
      mockDownloadsGet.mockResolvedValue({ default: { status: "bogus" } });
      await expect(manager.videoDownloadStatus("vid-1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("createVideoDownload", () => {
    it("calls stream.downloads.create with the account id", async () => {
      mockDownloadsCreate.mockResolvedValue({ default: { status: "inprogress", percentComplete: 0 } });
      const result = await manager.createVideoDownload("vid-1");
      expect(result.default.status).toBe("inprogress");
      expect(mockDownloadsCreate).toHaveBeenCalledWith("vid-1", { account_id: "acct-1" }, opts);
    });
  });

  describe("createAudioDownload", () => {
    it("posts to the raw audio endpoint with the bearer token and returns the audio entry", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { audio: { status: "inprogress", percentComplete: 0 } } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await manager.createAudioDownload("vid-1");

      expect(result).toEqual({ status: "inprogress", percentComplete: 0 });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/stream/vid-1/downloads/audio",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer tok-1" }),
        }),
      );
    });

    it("throws cloudflare/invalid_response on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
      await expect(manager.createAudioDownload("vid-1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("audioDownloadStatus", () => {
    it("extracts the audio entry from the generic downloads endpoint", async () => {
      mockDownloadsGet.mockResolvedValue({
        default: { status: "ready" },
        audio: { status: "ready", url: "https://audio.example.com" },
      });
      const result = await manager.audioDownloadStatus("vid-1");
      expect(result).toEqual({ status: "ready", url: "https://audio.example.com" });
    });

    it("returns an empty entry when no audio download exists", async () => {
      mockDownloadsGet.mockResolvedValue({ default: { status: "ready" } });
      expect(await manager.audioDownloadStatus("vid-1")).toEqual({});
    });
  });

  describe("createDirectUpload", () => {
    it("calls stream.directUpload.create", async () => {
      const response = { uid: "up-1", uploadURL: "https://up.example.com" };
      mockDirectUploadCreate.mockResolvedValue(response);
      const params = { maxDurationSeconds: 300 };
      expect(await manager.createDirectUpload(params)).toEqual(response);
      expect(mockDirectUploadCreate).toHaveBeenCalledWith({ account_id: "acct-1", ...params }, opts);
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when listing succeeds", async () => {
      mockList.mockResolvedValue([]);
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when listing fails", async () => {
      mockList.mockRejectedValue(new Error("unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  describe("download schemas", () => {
    it("round-trips a DownloadEntry through parse and a JSON encode", () => {
      const entry = { status: "ready" as const, url: "https://dl.example.com", percentComplete: 100 };
      const parsed = DownloadEntry.parse(entry);
      expect(parsed).toEqual(entry);
      expect(DownloadEntry.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(entry);
    });

    it("round-trips a StreamDownloadStatus", () => {
      const status = { default: { status: "ready" as const }, audio: { status: "inprogress" as const } };
      expect(StreamDownloadStatus.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockGet.mockRejectedValue("a bare string, not an Error");
    await expect(manager.getVideoDetails("vid-1")).rejects.toBeInstanceOf(PithyError);
  });
});
