import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareR2Manager } from "./r2Manager";

const { mockGetSignedUrl, mockBucketsGet } = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
  mockBucketsGet: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {},
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mockGetSignedUrl }));

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    r2 = { buckets: { get: mockBucketsGet } };
  },
}));

describe("CloudflareR2Manager", () => {
  const config = {
    accountId: "acct-1",
    apiToken: "tok-1",
    bucketName: "bucket-1",
    accessKeyId: "ak-1",
    secretAccessKey: "sk-1",
  };
  let manager: CloudflareR2Manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareR2Manager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type", () => {
      expect(manager.getServiceType()).toBe("Cloudflare R2");
    });

    it("throws cloudflare/not_configured when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareR2Manager({ ...config, apiToken: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws cloudflare/not_configured when bucketName is missing", () => {
      expect(() => new CloudflareR2Manager({ ...config, bucketName: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws cloudflare/not_configured when an S3 credential is empty", () => {
      expect(() => new CloudflareR2Manager({ ...config, accessKeyId: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("createUploadUrl", () => {
    it("presigns a PUT command for the bucket", async () => {
      mockGetSignedUrl.mockResolvedValue("https://presigned-upload.example.com");
      const result = await manager.createUploadUrl("docs/a.pdf", "application/pdf", 1024);
      expect(result).toBe("https://presigned-upload.example.com");
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          input: { Bucket: "bucket-1", Key: "docs/a.pdf", ContentType: "application/pdf", ContentLength: 1024 },
        }),
        { expiresIn: 3600 },
      );
    });

    it("wraps a signing failure as cloudflare/request_failed", async () => {
      mockGetSignedUrl.mockRejectedValue(new Error("bad creds"));
      await expect(manager.createUploadUrl("k", "t", 0)).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "bad creds" }),
        }),
      );
    });
  });

  describe("createDownloadUrl", () => {
    it("presigns a GET command for the bucket", async () => {
      mockGetSignedUrl.mockResolvedValue("https://presigned-download.example.com");
      const result = await manager.createDownloadUrl("docs/a.pdf");
      expect(result).toBe("https://presigned-download.example.com");
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ input: { Bucket: "bucket-1", Key: "docs/a.pdf" } }),
        { expiresIn: 3600 },
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the bucket record is reachable over the CF API", async () => {
      mockBucketsGet.mockResolvedValue({ name: "bucket-1" });
      expect(await manager.validateServiceAccess()).toBe(true);
      expect(mockBucketsGet).toHaveBeenCalledWith("bucket-1", { account_id: "acct-1" });
    });

    it("returns false when the bucket is not reachable", async () => {
      mockBucketsGet.mockRejectedValue(new Error("Unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  describe("S3 client caching", () => {
    it("reuses the same S3 client across calls", async () => {
      mockGetSignedUrl.mockResolvedValue("https://url.example.com");
      await manager.createUploadUrl("k1", "t", 100);
      await manager.createDownloadUrl("k2");
      expect(mockGetSignedUrl.mock.calls[0]?.[0]).toBe(mockGetSignedUrl.mock.calls[1]?.[0]);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockGetSignedUrl.mockRejectedValue("a bare string, not an Error");
    await expect(manager.createUploadUrl("k", "t", 0)).rejects.toBeInstanceOf(PithyError);
  });
});
