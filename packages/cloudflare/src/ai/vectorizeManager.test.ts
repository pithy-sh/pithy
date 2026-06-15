import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareVectorizeManager, type VectorizeVector } from "./vectorizeManager";

const mockInsert = vi.fn();
const mockUpsert = vi.fn();
const mockQuery = vi.fn();
const mockGetByIds = vi.fn();
const mockDeleteByIds = vi.fn();
const mockInfo = vi.fn();
const mockGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    vectorize = {
      indexes: {
        insert: mockInsert,
        upsert: mockUpsert,
        query: mockQuery,
        getByIds: mockGetByIds,
        deleteByIds: mockDeleteByIds,
        info: mockInfo,
        get: mockGet,
      },
    };
  },
}));

describe("CloudflareVectorizeManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1", indexName: "my-index" };
  let manager: CloudflareVectorizeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareVectorizeManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type and vectorize info", () => {
      expect(manager.getServiceType()).toBe("Vectorize");
      expect(manager.getVectorizeInfo()).toEqual({ indexName: "my-index", accountId: "acct-1" });
    });

    it("throws a configured PithyError when indexName is missing", () => {
      expect(() => new CloudflareVectorizeManager({ accountId: "a", apiToken: "t", indexName: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareVectorizeManager({ accountId: "a", apiToken: "", indexName: "i" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("insert", () => {
    it("calls the REST API with an NDJSON body", async () => {
      mockInsert.mockResolvedValue({ mutationId: "mut-1" });
      const vectors: VectorizeVector[] = [{ id: "v1", values: [0.1] }];
      const result = await manager.insert(vectors);
      expect(mockInsert).toHaveBeenCalledWith(
        "my-index",
        expect.objectContaining({ account_id: "acct-1", body: expect.any(File) }),
      );
      expect(result).toEqual({ mutationId: "mut-1" });
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause kept in detail", async () => {
      mockInsert.mockRejectedValue(new Error("Rate limited"));
      await expect(manager.insert([])).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Rate limited" }),
        }),
      );
    });

    it("only ever throws PithyError, even on a non-Error throw", async () => {
      mockInsert.mockRejectedValue("string error");
      await expect(manager.insert([])).rejects.toBeInstanceOf(PithyError);
    });
  });

  describe("upsert", () => {
    it("calls the REST API with an NDJSON body", async () => {
      mockUpsert.mockResolvedValue({ mutationId: "mut-2" });
      const vectors: VectorizeVector[] = [{ id: "v1", values: [0.1] }];
      const result = await manager.upsert(vectors);
      expect(mockUpsert).toHaveBeenCalledWith(
        "my-index",
        expect.objectContaining({ account_id: "acct-1", body: expect.any(File) }),
      );
      expect(result).toEqual({ mutationId: "mut-2" });
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockUpsert.mockRejectedValue(new Error("API error"));
      await expect(manager.upsert([])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("query", () => {
    it("calls the REST API with the vector and options", async () => {
      const result = { count: 1, matches: [{ id: "v1", score: 0.9 }] };
      mockQuery.mockResolvedValue(result);
      const response = await manager.query([0.1, 0.2], { topK: 5 });
      expect(mockQuery).toHaveBeenCalledWith(
        "my-index",
        expect.objectContaining({ account_id: "acct-1", vector: [0.1, 0.2], topK: 5 }),
      );
      expect(response).toEqual(result);
    });

    it("omits options that are not provided", async () => {
      mockQuery.mockResolvedValue({ count: 0, matches: [] });
      await manager.query([0.1]);
      expect(mockQuery).toHaveBeenCalledWith("my-index", { account_id: "acct-1", vector: [0.1] });
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockQuery.mockRejectedValue(new Error("Timeout"));
      await expect(manager.query([0.1])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("queryById", () => {
    it("fetches the vector by id then queries with its values", async () => {
      mockGetByIds.mockResolvedValue([{ id: "v1", values: [0.1, 0.2, 0.3] }]);
      const queryResult = { count: 1, matches: [{ id: "v2", score: 0.9 }] };
      mockQuery.mockResolvedValue(queryResult);
      const response = await manager.queryById("v1", { topK: 5 });
      expect(mockGetByIds).toHaveBeenCalledWith("my-index", { account_id: "acct-1", ids: ["v1"] });
      expect(mockQuery).toHaveBeenCalledWith(
        "my-index",
        expect.objectContaining({ account_id: "acct-1", vector: [0.1, 0.2, 0.3], topK: 5 }),
      );
      expect(response).toEqual(queryResult);
    });

    it("returns empty matches when the id is not found", async () => {
      mockGetByIds.mockResolvedValue([]);
      const response = await manager.queryById("nonexistent");
      expect(response).toEqual({ count: 0, matches: [] });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockGetByIds.mockRejectedValue(new Error("Service error"));
      await expect(manager.queryById("v1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("getByIds", () => {
    it("calls the REST API with the ids and returns the array", async () => {
      const result = [{ id: "v1", values: [0.1] }];
      mockGetByIds.mockResolvedValue(result);
      const response = await manager.getByIds(["v1"]);
      expect(mockGetByIds).toHaveBeenCalledWith("my-index", { account_id: "acct-1", ids: ["v1"] });
      expect(response).toEqual(result);
    });

    it("returns an empty array when the response is not an array", async () => {
      mockGetByIds.mockResolvedValue(null);
      expect(await manager.getByIds(["v1"])).toEqual([]);
    });
  });

  describe("deleteByIds", () => {
    it("calls the REST API with the ids", async () => {
      mockDeleteByIds.mockResolvedValue({ mutationId: "mut-1" });
      const response = await manager.deleteByIds(["v1"]);
      expect(mockDeleteByIds).toHaveBeenCalledWith("my-index", { account_id: "acct-1", ids: ["v1"] });
      expect(response).toEqual({ mutationId: "mut-1" });
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockDeleteByIds.mockRejectedValue(new Error("Permission denied"));
      await expect(manager.deleteByIds(["v1"])).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("describe", () => {
    it("calls the REST info endpoint", async () => {
      const result = { vectorCount: 100, dimensions: 1024 };
      mockInfo.mockResolvedValue(result);
      const response = await manager.describe();
      expect(mockInfo).toHaveBeenCalledWith("my-index", { account_id: "acct-1" });
      expect(response).toEqual(result);
    });

    it("wraps an SDK failure as cloudflare/request_failed", async () => {
      mockInfo.mockRejectedValue(new Error("Service unavailable"));
      await expect(manager.describe()).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the index is reachable", async () => {
      mockGet.mockResolvedValue({ name: "my-index" });
      expect(await manager.validateServiceAccess()).toBe(true);
      expect(mockGet).toHaveBeenCalledWith("my-index", { account_id: "acct-1" });
    });

    it("returns false when the index is not reachable", async () => {
      mockGet.mockRejectedValue(new Error("Not found"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });
});
