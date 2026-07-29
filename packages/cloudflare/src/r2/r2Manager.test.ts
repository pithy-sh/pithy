import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareR2Manager } from "./r2Manager";

const { mockGetSignedUrl, mockBucketsGet, mockSend } = vi.hoisted(() => ({
  mockGetSignedUrl: vi.fn(),
  mockBucketsGet: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  // Each command mock records the name it was constructed as, so a test can assert *which* S3
  // command the manager sent as well as its exact input.
  const command = (commandName: string) =>
    class {
      readonly commandName = commandName;
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };
  return {
    S3Client: class {
      send = mockSend;
    },
    PutObjectCommand: command("PutObject"),
    GetObjectCommand: command("GetObject"),
    CreateMultipartUploadCommand: command("CreateMultipartUpload"),
    UploadPartCommand: command("UploadPart"),
    CompleteMultipartUploadCommand: command("CompleteMultipartUpload"),
    AbortMultipartUploadCommand: command("AbortMultipartUpload"),
    ListPartsCommand: command("ListParts"),
    ListMultipartUploadsCommand: command("ListMultipartUploads"),
    HeadObjectCommand: command("HeadObject"),
    ListObjectsV2Command: command("ListObjectsV2"),
    CopyObjectCommand: command("CopyObject"),
    DeleteObjectCommand: command("DeleteObject"),
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mockGetSignedUrl }));

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    r2 = { buckets: { get: mockBucketsGet } };
  },
}));

/** An AWS SDK 404 as the S3 client surfaces it — the shape `isS3NotFound` has to recognise. */
function s3NotFound(name: string): Error & { name: string; $metadata: { httpStatusCode: number } } {
  const error = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

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

    it("throws cloudflare/not_configured when accountId is missing (base guard)", () => {
      expect(() => new CloudflareR2Manager({ ...config, accountId: "" })).toThrowError(
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

    it("throws cloudflare/not_configured when the secret key is empty", () => {
      expect(() => new CloudflareR2Manager({ ...config, secretAccessKey: "" })).toThrowError(
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

    it("honours an explicit expiresIn", async () => {
      mockGetSignedUrl.mockResolvedValue("https://url.example.com");
      await manager.createUploadUrl("k", "t", 1, { expiresIn: 60 });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { expiresIn: 60 });
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

    it("honours an explicit expiresIn", async () => {
      mockGetSignedUrl.mockResolvedValue("https://url.example.com");
      await manager.createDownloadUrl("k", { expiresIn: 120 });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { expiresIn: 120 });
    });
  });

  describe("createMultipartUpload", () => {
    it("sends CreateMultipartUpload and returns the upload id", async () => {
      mockSend.mockResolvedValue({ UploadId: "up-1" });
      expect(await manager.createMultipartUpload("videos/a.mp4", "video/mp4")).toBe("up-1");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: "CreateMultipartUpload",
          input: { Bucket: "bucket-1", Key: "videos/a.mp4", ContentType: "video/mp4" },
        }),
      );
    });

    it("throws cloudflare/invalid_response when R2 returns no upload id", async () => {
      mockSend.mockResolvedValue({});
      await expect(manager.createMultipartUpload("k", "t")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("is never presigned — a client has no business opening an upload", async () => {
      mockSend.mockResolvedValue({ UploadId: "up-1" });
      await manager.createMultipartUpload("k", "t");
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe("presignUploadPart", () => {
    it("presigns an UploadPart command without ContentLength by default", async () => {
      mockGetSignedUrl.mockResolvedValue("https://part.example.com");
      const url = await manager.presignUploadPart("videos/a.mp4", "up-1", 3);
      expect(url).toBe("https://part.example.com");
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          commandName: "UploadPart",
          input: { Bucket: "bucket-1", Key: "videos/a.mp4", UploadId: "up-1", PartNumber: 3 },
        }),
        { expiresIn: 3600 },
      );
    });

    it("pins ContentLength when the caller knows the exact part size", async () => {
      mockGetSignedUrl.mockResolvedValue("https://part.example.com");
      await manager.presignUploadPart("k", "up-1", 1, { contentLength: 5242880, expiresIn: 900 });
      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          input: { Bucket: "bucket-1", Key: "k", UploadId: "up-1", PartNumber: 1, ContentLength: 5242880 },
        }),
        { expiresIn: 900 },
      );
    });
  });

  describe("completeMultipartUpload", () => {
    it("sends the parts sorted ascending with their etags verbatim", async () => {
      mockSend.mockResolvedValue({});
      await manager.completeMultipartUpload("k", "up-1", [
        { partNumber: 3, etag: '"c"' },
        { partNumber: 1, etag: '"a"' },
        { partNumber: 2, etag: '"b"' },
      ]);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: "CompleteMultipartUpload",
          input: {
            Bucket: "bucket-1",
            Key: "k",
            UploadId: "up-1",
            MultipartUpload: {
              Parts: [
                { PartNumber: 1, ETag: '"a"' },
                { PartNumber: 2, ETag: '"b"' },
                { PartNumber: 3, ETag: '"c"' },
              ],
            },
          },
        }),
      );
    });

    it("wraps a completion failure as cloudflare/request_failed", async () => {
      mockSend.mockRejectedValue(new Error("EntityTooSmall"));
      await expect(manager.completeMultipartUpload("k", "up-1", [{ partNumber: 1, etag: "e" }])).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "EntityTooSmall" }),
        }),
      );
    });
  });

  describe("abortMultipartUpload", () => {
    it("sends AbortMultipartUpload for the upload", async () => {
      mockSend.mockResolvedValue({});
      await manager.abortMultipartUpload("k", "up-1");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: "AbortMultipartUpload",
          input: { Bucket: "bucket-1", Key: "k", UploadId: "up-1" },
        }),
      );
    });

    it("is idempotent — an upload R2 has already forgotten is not an error", async () => {
      mockSend.mockRejectedValue(s3NotFound("NoSuchUpload"));
      await expect(manager.abortMultipartUpload("k", "gone")).resolves.toBeUndefined();
    });

    it("still surfaces a non-404 failure", async () => {
      mockSend.mockRejectedValue(new Error("InternalError"));
      await expect(manager.abortMultipartUpload("k", "up-1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("listParts", () => {
    it("drains every page and returns parts ascending", async () => {
      mockSend
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: 100 }],
          IsTruncated: true,
          NextPartNumberMarker: "2",
        })
        .mockResolvedValueOnce({ Parts: [{ PartNumber: 1, ETag: '"a"', Size: 200 }], IsTruncated: false });
      expect(await manager.listParts("k", "up-1")).toEqual([
        { partNumber: 1, etag: '"a"', size: 200 },
        { partNumber: 2, etag: '"b"', size: 100 },
      ]);
      expect(mockSend).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          commandName: "ListParts",
          input: { Bucket: "bucket-1", Key: "k", UploadId: "up-1", MaxParts: 1000, PartNumberMarker: undefined },
        }),
      );
      expect(mockSend).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          input: { Bucket: "bucket-1", Key: "k", UploadId: "up-1", MaxParts: 1000, PartNumberMarker: "2" },
        }),
      );
    });

    it("returns an empty list when nothing has been uploaded yet", async () => {
      mockSend.mockResolvedValue({ IsTruncated: false });
      expect(await manager.listParts("k", "up-1")).toEqual([]);
    });

    it("throws cloudflare/invalid_response when a part is missing its etag", async () => {
      mockSend.mockResolvedValue({ Parts: [{ PartNumber: 1, Size: 10 }], IsTruncated: false });
      await expect(manager.listParts("k", "up-1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("headObject", () => {
    it("decodes the object metadata", async () => {
      const uploaded = new Date("2026-01-01T00:00:00.000Z");
      mockSend.mockResolvedValue({
        ContentLength: 42,
        ETag: '"e"',
        ContentType: "image/png",
        LastModified: uploaded,
      });
      expect(await manager.headObject("img/a.png")).toEqual({
        size: 42,
        etag: '"e"',
        contentType: "image/png",
        uploaded,
      });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ commandName: "HeadObject", input: { Bucket: "bucket-1", Key: "img/a.png" } }),
      );
    });

    it("returns null for an absent object", async () => {
      mockSend.mockRejectedValue(s3NotFound("NotFound"));
      expect(await manager.headObject("missing")).toBeNull();
    });

    it("throws cloudflare/invalid_response when R2 omits the size", async () => {
      mockSend.mockResolvedValue({ ETag: '"e"' });
      await expect(manager.headObject("k")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("listObjects", () => {
    it("returns one page and a cursor when more remain", async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: "a" }, { Key: "b" }],
        IsTruncated: true,
        NextContinuationToken: "tok-2",
      });
      expect(await manager.listObjects({ prefix: "obj/", cursor: "tok-1", maxKeys: 2 })).toEqual({
        keys: ["a", "b"],
        cursor: "tok-2",
      });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: "ListObjectsV2",
          input: { Bucket: "bucket-1", Prefix: "obj/", ContinuationToken: "tok-1", MaxKeys: 2 },
        }),
      );
    });

    it("omits the cursor on the last page and drops keyless entries", async () => {
      mockSend.mockResolvedValue({ Contents: [{ Key: "a" }, {}], IsTruncated: false, NextContinuationToken: "stale" });
      expect(await manager.listObjects()).toEqual({ keys: ["a"] });
    });

    it("returns an empty page for an empty bucket", async () => {
      mockSend.mockResolvedValue({});
      expect(await manager.listObjects()).toEqual({ keys: [] });
    });
  });

  describe("copyObject", () => {
    it("percent-encodes the source key per path segment", async () => {
      mockSend.mockResolvedValue({});
      await manager.copyObject("obj/my file?.png", "obj/copy.png");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: "CopyObject",
          input: {
            Bucket: "bucket-1",
            Key: "obj/copy.png",
            CopySource: "/bucket-1/obj/my%20file%3F.png",
          },
        }),
      );
    });
  });

  describe("deleteObject", () => {
    it("sends DeleteObject for the key", async () => {
      mockSend.mockResolvedValue({});
      await manager.deleteObject("obj/a.png");
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ commandName: "DeleteObject", input: { Bucket: "bucket-1", Key: "obj/a.png" } }),
      );
    });
  });

  describe("listMultipartUploads", () => {
    it("drains every page and skips an entry missing its key or id", async () => {
      mockSend
        .mockResolvedValueOnce({
          Uploads: [{ Key: "a", UploadId: "up-a" }, { Key: "b" }],
          IsTruncated: true,
          NextKeyMarker: "b",
          NextUploadIdMarker: "up-b",
        })
        .mockResolvedValueOnce({ Uploads: [{ Key: "c", UploadId: "up-c" }], IsTruncated: false });
      expect(await manager.listMultipartUploads("obj/")).toEqual([
        { key: "a", uploadId: "up-a" },
        { key: "c", uploadId: "up-c" },
      ]);
      expect(mockSend).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          commandName: "ListMultipartUploads",
          input: { Bucket: "bucket-1", Prefix: "obj/", KeyMarker: undefined, UploadIdMarker: undefined },
        }),
      );
      expect(mockSend).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          input: { Bucket: "bucket-1", Prefix: "obj/", KeyMarker: "b", UploadIdMarker: "up-b" },
        }),
      );
    });
  });

  describe("emptyBucket", () => {
    it("aborts every in-flight upload first, then deletes every key on every page", async () => {
      mockSend
        // The pending uploads. Nothing else can see these, and R2 blocks a bucket delete while they exist.
        .mockResolvedValueOnce({ Uploads: [{ Key: "half/a.bin", UploadId: "up-1" }], IsTruncated: false })
        .mockResolvedValueOnce({}) // AbortMultipartUpload
        .mockResolvedValueOnce({ Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "tok-2" })
        .mockResolvedValueOnce({}) // DeleteObject a
        .mockResolvedValueOnce({ Contents: [{ Key: "b" }], IsTruncated: false })
        .mockResolvedValueOnce({}); // DeleteObject b

      expect(await manager.emptyBucket()).toEqual({ objectsDeleted: 2, uploadsAborted: 1 });

      // The order is the contract: an upload that is aborted only after the keys are drained leaves a
      // bucket that lists as empty and still refuses to be deleted.
      expect(mockSend.mock.calls.map((call) => (call[0] as { commandName: string }).commandName)).toEqual([
        "ListMultipartUploads",
        "AbortMultipartUpload",
        "ListObjectsV2",
        "DeleteObject",
        "ListObjectsV2",
        "DeleteObject",
      ]);
      expect(mockSend).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ input: { Bucket: "bucket-1", Key: "half/a.bin", UploadId: "up-1" } }),
      );
      // The second listing carries the first page's cursor — a drain that dropped it would loop on page one.
      expect(mockSend).toHaveBeenNthCalledWith(
        5,
        expect.objectContaining({
          input: { Bucket: "bucket-1", Prefix: undefined, ContinuationToken: "tok-2", MaxKeys: undefined },
        }),
      );
      expect(mockSend).toHaveBeenNthCalledWith(6, expect.objectContaining({ input: { Bucket: "bucket-1", Key: "b" } }));
    });

    it("is a no-op on an already-empty bucket, so a retried teardown is safe", async () => {
      mockSend.mockResolvedValue({});
      expect(await manager.emptyBucket()).toEqual({ objectsDeleted: 0, uploadsAborted: 0 });
      expect(mockSend.mock.calls.map((call) => (call[0] as { commandName: string }).commandName)).toEqual([
        "ListMultipartUploads",
        "ListObjectsV2",
      ]);
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
    mockSend.mockRejectedValue("a bare string, not an Error");
    await expect(manager.createUploadUrl("k", "t", 0)).rejects.toBeInstanceOf(PithyError);
    await expect(manager.createDownloadUrl("k")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.presignUploadPart("k", "up-1", 1)).rejects.toBeInstanceOf(PithyError);
    await expect(manager.createMultipartUpload("k", "t")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.completeMultipartUpload("k", "up-1", [])).rejects.toBeInstanceOf(PithyError);
    await expect(manager.abortMultipartUpload("k", "up-1")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.listParts("k", "up-1")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.listMultipartUploads()).rejects.toBeInstanceOf(PithyError);
    await expect(manager.emptyBucket()).rejects.toBeInstanceOf(PithyError);
    await expect(manager.headObject("k")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.listObjects()).rejects.toBeInstanceOf(PithyError);
    await expect(manager.copyObject("a", "b")).rejects.toBeInstanceOf(PithyError);
    await expect(manager.deleteObject("k")).rejects.toBeInstanceOf(PithyError);
  });
});
