import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareImageManager } from "./imageManager";

const mockV1Create = vi.fn();
const mockV1Get = vi.fn();
const mockV1Edit = vi.fn();
const mockV1Delete = vi.fn();
const mockV2List = vi.fn();
const mockDirectUploadsCreate = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    images = {
      v1: { create: mockV1Create, get: mockV1Get, edit: mockV1Edit, delete: mockV1Delete },
      v2: { list: mockV2List, directUploads: { create: mockDirectUploadsCreate } },
    };
  },
}));

const opts = { maxRetries: 3, timeout: 10000 };

describe("CloudflareImageManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1" };
  let manager: CloudflareImageManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareImageManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type", () => {
      expect(manager.getServiceType()).toBe("Cloudflare Images");
    });

    it("throws cloudflare/not_configured when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareImageManager({ accountId: "a", apiToken: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("uploadImage", () => {
    it("calls v1.create with account id and JSON-stringified metadata", async () => {
      const response = { id: "img-1", filename: "a.jpg", variants: [] };
      mockV1Create.mockResolvedValue(response);
      const params = { metadata: { tag: "a" }, requireSignedURLs: false };

      expect(await manager.uploadImage(params)).toEqual(response);
      expect(mockV1Create).toHaveBeenCalledWith(
        { account_id: "acct-1", ...params, metadata: JSON.stringify(params.metadata) },
        opts,
      );
    });

    it("leaves absent metadata untouched", async () => {
      mockV1Create.mockResolvedValue({ id: "img-1" });
      await manager.uploadImage({ requireSignedURLs: false });
      expect(mockV1Create).toHaveBeenCalledWith(
        { account_id: "acct-1", requireSignedURLs: false, metadata: undefined },
        opts,
      );
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause in detail", async () => {
      mockV1Create.mockRejectedValue(new Error("upload boom"));
      await expect(manager.uploadImage({})).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "upload boom" }),
        }),
      );
    });
  });

  describe("imageDetails", () => {
    it("calls v1.get", async () => {
      const response = { id: "img-1" };
      mockV1Get.mockResolvedValue(response);
      expect(await manager.imageDetails("img-1")).toEqual(response);
      expect(mockV1Get).toHaveBeenCalledWith("img-1", { account_id: "acct-1" }, opts);
    });
  });

  describe("updateImage", () => {
    it("calls v1.edit with merged params", async () => {
      const response = { id: "img-1" };
      mockV1Edit.mockResolvedValue(response);
      const params = { requireSignedURLs: true };
      expect(await manager.updateImage("img-1", params)).toEqual(response);
      expect(mockV1Edit).toHaveBeenCalledWith("img-1", { account_id: "acct-1", ...params }, opts);
    });
  });

  describe("deleteImage", () => {
    it("calls v1.delete", async () => {
      mockV1Delete.mockResolvedValue(undefined);
      await manager.deleteImage("img-1");
      expect(mockV1Delete).toHaveBeenCalledWith("img-1", { account_id: "acct-1" }, opts);
    });
  });

  describe("createDirectUploadUrl", () => {
    it("calls v2.directUploads.create with stringified metadata", async () => {
      const response = { id: "img-1", uploadURL: "https://up.example.com" };
      mockDirectUploadsCreate.mockResolvedValue(response);
      const params = { metadata: { tag: "a" }, requireSignedURLs: false };
      expect(await manager.createDirectUploadUrl(params)).toEqual(response);
      expect(mockDirectUploadsCreate).toHaveBeenCalledWith(
        { account_id: "acct-1", ...params, metadata: JSON.stringify(params.metadata) },
        opts,
      );
    });
  });

  describe("listImages", () => {
    it("returns the first page's images", async () => {
      mockV2List.mockResolvedValue({ images: [{ id: "img-1" }], continuation_token: null });
      const result = await manager.listImages();
      expect(result).toEqual([{ id: "img-1" }]);
      expect(mockV2List).toHaveBeenCalledWith({ account_id: "acct-1" }, opts);
    });

    it("returns an empty array when the page has no images", async () => {
      mockV2List.mockResolvedValue({ continuation_token: null });
      expect(await manager.listImages()).toEqual([]);
    });
  });

  describe("listAllImages", () => {
    it("follows the continuation token across pages", async () => {
      mockV2List
        .mockResolvedValueOnce({ images: [{ id: "img-1" }], continuation_token: "t1" })
        .mockResolvedValueOnce({ images: [{ id: "img-2" }], continuation_token: null });

      const result = await manager.listAllImages();

      expect(result).toEqual([{ id: "img-1" }, { id: "img-2" }]);
      expect(mockV2List).toHaveBeenCalledTimes(2);
      expect(mockV2List).toHaveBeenNthCalledWith(1, { account_id: "acct-1", continuation_token: undefined }, opts);
      expect(mockV2List).toHaveBeenNthCalledWith(2, { account_id: "acct-1", continuation_token: "t1" }, opts);
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when listing succeeds", async () => {
      mockV2List.mockResolvedValue({ images: [], continuation_token: null });
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when listing fails", async () => {
      mockV2List.mockRejectedValue(new Error("unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockV1Get.mockRejectedValue("a bare string, not an Error");
    await expect(manager.imageDetails("img-1")).rejects.toBeInstanceOf(PithyError);
  });
});
