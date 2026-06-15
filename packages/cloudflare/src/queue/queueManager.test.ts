import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareQueueManager } from "./queueManager";

const mockQueuesList = vi.fn();
const mockBulkPush = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    queues = {
      list: mockQueuesList,
      messages: { bulkPush: mockBulkPush },
    };
  },
}));

const stubQueueList = (queues: Array<{ queue_name: string; queue_id: string }>) =>
  mockQueuesList.mockResolvedValue({ result: queues });

describe("CloudflareQueueManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1", queueName: "my-queue" };
  let manager: CloudflareQueueManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareQueueManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type and queue info", () => {
      expect(manager.getServiceType()).toBe("Queues");
      expect(manager.getQueueInfo()).toEqual({ queueName: "my-queue", accountId: "acct-1", queueId: undefined });
    });

    it("throws a configured PithyError when queueName is missing", () => {
      expect(() => new CloudflareQueueManager({ accountId: "a", apiToken: "t", queueName: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareQueueManager({ accountId: "a", apiToken: "", queueName: "q" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("getQueueId", () => {
    it("finds the queue by name from the list", async () => {
      stubQueueList([
        { queue_name: "other", queue_id: "q-other" },
        { queue_name: "my-queue", queue_id: "q-123" },
      ]);
      expect(await manager.getQueueId()).toBe("q-123");
      expect(mockQueuesList).toHaveBeenCalledWith({ account_id: "acct-1" });
    });

    it("caches the queue id on subsequent calls", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      await manager.getQueueId();
      await manager.getQueueId();
      expect(mockQueuesList).toHaveBeenCalledTimes(1);
    });

    it("throws core/not_found when the queue is not found", async () => {
      stubQueueList([{ queue_name: "other", queue_id: "q-other" }]);
      await expect(manager.getQueueId()).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "core/not_found" }),
        }),
      );
    });

    it("wraps an SDK list failure as cloudflare/request_failed with the cause in detail", async () => {
      mockQueuesList.mockRejectedValue(new Error("network"));
      await expect(manager.getQueueId()).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "network" }),
        }),
      );
    });
  });

  describe("sendBatch", () => {
    it("sends messages via the REST bulk push", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValue({ success: true });
      await manager.sendBatch([{ type: "test" }]);
      expect(mockBulkPush).toHaveBeenCalledWith("q-123", {
        account_id: "acct-1",
        messages: [{ body: { type: "test" } }],
      });
    });

    it("throws cloudflare/invalid_response when the API reports failure", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValue({ success: false, errors: ["quota exceeded"] });
      await expect(manager.sendBatch([{ type: "test" }])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });

    it("wraps an SDK push failure as cloudflare/request_failed with the cause in detail", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockRejectedValue(new Error("boom"));
      await expect(manager.sendBatch([{ type: "test" }])).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "boom" }),
        }),
      );
    });
  });

  describe("send", () => {
    it("delegates a single message to the bulk push", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValue({ success: true });
      await manager.send({ type: "hello" });
      expect(mockBulkPush).toHaveBeenCalledWith("q-123", {
        account_id: "acct-1",
        messages: [{ body: { type: "hello" } }],
      });
    });
  });

  describe("sendBatches", () => {
    it("processes all batches and returns aggregate results", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValue({ success: true });
      const result = await manager.sendBatches([
        { batchNumber: 1, messageCount: 2, messages: [{ a: 1 }, { a: 2 }] },
        { batchNumber: 2, messageCount: 1, messages: [{ a: 3 }] },
      ]);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.success)).toBe(true);
    });

    it("calls progress and success callbacks", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValue({ success: true });
      const onProgress = vi.fn();
      const onSuccess = vi.fn();
      await manager.sendBatches([{ batchNumber: 1, messageCount: 3, messages: [1, 2, 3] }], {
        onProgress,
        onSuccess,
      });
      expect(onProgress).toHaveBeenCalledWith(1, 1, 3);
      expect(onSuccess).toHaveBeenCalledWith(1, 3);
    });

    it("continues past a failed batch and reports it (default)", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error("quota"));
      const onError = vi.fn();
      const result = await manager.sendBatches(
        [
          { batchNumber: 1, messageCount: 1, messages: [{ a: 1 }] },
          { batchNumber: 2, messageCount: 1, messages: [{ a: 2 }] },
        ],
        { onError },
      );
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.results[1]?.success).toBe(false);
      expect(result.results[1]?.error).toContain("quota");
      expect(onError).toHaveBeenCalledWith(2, expect.stringContaining("quota"));
    });

    it("throws on the first failure when continueOnError is false", async () => {
      stubQueueList([{ queue_name: "my-queue", queue_id: "q-123" }]);
      mockBulkPush.mockRejectedValue(new Error("nope"));
      await expect(
        manager.sendBatches([{ batchNumber: 1, messageCount: 1, messages: [{ a: 1 }] }], { continueOnError: false }),
      ).rejects.toBeInstanceOf(PithyError);
    });

    it("fails before sending any batch when the queue cannot be resolved", async () => {
      stubQueueList([{ queue_name: "other", queue_id: "q-other" }]);
      await expect(
        manager.sendBatches([{ batchNumber: 1, messageCount: 1, messages: [{ a: 1 }] }]),
      ).rejects.toThrowError(expect.objectContaining({ payload: expect.objectContaining({ code: "core/not_found" }) }));
      expect(mockBulkPush).not.toHaveBeenCalled();
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when queues are listable", async () => {
      mockQueuesList.mockResolvedValue({ result: [] });
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false on failure", async () => {
      mockQueuesList.mockRejectedValue(new Error("Unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockQueuesList.mockRejectedValue("a bare string, not an Error");
    await expect(manager.getQueueId()).rejects.toBeInstanceOf(PithyError);
  });
});
