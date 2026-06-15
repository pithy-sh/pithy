import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareKVManager } from "./kvManager";

const mockValuesGet = vi.fn();
const mockValuesUpdate = vi.fn();
const mockValuesDelete = vi.fn();
const mockKeysList = vi.fn();
const mockNamespacesGet = vi.fn();
const mockMetadataGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    kv = {
      namespaces: {
        get: mockNamespacesGet,
        values: { get: mockValuesGet, update: mockValuesUpdate, delete: mockValuesDelete },
        keys: { list: mockKeysList },
        metadata: { get: mockMetadataGet },
      },
    };
  },
}));

describe("CloudflareKVManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1", namespaceId: "ns-123" };
  let manager: CloudflareKVManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareKVManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type and KV info", () => {
      expect(manager.getServiceType()).toBe("KV Storage");
      expect(manager.getKVInfo()).toEqual({ namespaceId: "ns-123", accountId: "acct-1" });
    });

    it("throws a configured PithyError when namespaceId is missing", () => {
      expect(() => new CloudflareKVManager({ accountId: "a", apiToken: "t", namespaceId: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws when apiToken is missing (base guard)", () => {
      expect(() => new CloudflareKVManager({ accountId: "a", apiToken: "", namespaceId: "ns" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("get", () => {
    it("returns a text value", async () => {
      mockValuesGet.mockResolvedValue("hello");
      expect(await manager.get("k1")).toBe("hello");
      expect(mockValuesGet).toHaveBeenCalledWith("ns-123", "k1", { account_id: "acct-1" });
    });

    it("returns null for a missing key", async () => {
      mockValuesGet.mockResolvedValue(null);
      expect(await manager.get("k1")).toBeNull();
    });

    it("returns null when the SDK throws a 404 for an absent key (not request_failed)", async () => {
      mockValuesGet.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
      expect(await manager.get("k1")).toBeNull();
    });

    it("wraps an SDK failure as cloudflare/request_failed with the cause kept in detail", async () => {
      mockValuesGet.mockRejectedValue(new Error("timeout"));
      await expect(manager.get("k1")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "timeout" }),
        }),
      );
    });
  });

  describe("getJson", () => {
    it("parses JSON values", async () => {
      mockValuesGet.mockResolvedValue('{"a":1}');
      expect(await manager.getJson("k1")).toEqual({ a: 1 });
    });

    it("returns null when the key is absent", async () => {
      mockValuesGet.mockResolvedValue(null);
      expect(await manager.getJson("k1")).toBeNull();
    });

    it("throws cloudflare/invalid_response on malformed JSON", async () => {
      mockValuesGet.mockResolvedValue("not json");
      await expect(manager.getJson("k1")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/invalid_response" }) }),
      );
    });
  });

  describe("set", () => {
    it("writes a value with TTL and metadata, mapping to the REST shape", async () => {
      mockValuesUpdate.mockResolvedValue(undefined);
      await manager.set("k1", "v1", { expirationTtl: 60, metadata: { tag: "a" } });
      expect(mockValuesUpdate).toHaveBeenCalledWith("ns-123", "k1", {
        account_id: "acct-1",
        value: "v1",
        expiration_ttl: 60,
        metadata: JSON.stringify({ tag: "a" }),
      });
    });

    it("omits TTL and metadata when not given", async () => {
      mockValuesUpdate.mockResolvedValue(undefined);
      await manager.set("k1", "v1");
      expect(mockValuesUpdate).toHaveBeenCalledWith("ns-123", "k1", { account_id: "acct-1", value: "v1" });
    });
  });

  describe("delete", () => {
    it("deletes via the REST API", async () => {
      mockValuesDelete.mockResolvedValue(undefined);
      await manager.delete("k1");
      expect(mockValuesDelete).toHaveBeenCalledWith("ns-123", "k1", { account_id: "acct-1" });
    });
  });

  describe("listKeys", () => {
    it("lists keys with prefix and limit", async () => {
      mockKeysList.mockResolvedValue({ result: [{ name: "k1" }, { name: "k2" }] });
      const keys = await manager.listKeys("prefix", 10);
      expect(keys).toEqual([{ name: "k1" }, { name: "k2" }]);
      expect(mockKeysList).toHaveBeenCalledWith("ns-123", { account_id: "acct-1", prefix: "prefix", limit: 10 });
    });
  });

  describe("getWithMetadata", () => {
    it("returns value and metadata together", async () => {
      mockValuesGet.mockResolvedValue("val");
      mockMetadataGet.mockResolvedValue({ created: "2025-01-01" });
      expect(await manager.getWithMetadata("k1")).toEqual({ value: "val", metadata: { created: "2025-01-01" } });
    });

    it("returns null metadata when the metadata fetch fails", async () => {
      mockValuesGet.mockResolvedValue("val");
      mockMetadataGet.mockRejectedValue(new Error("no metadata"));
      const result = await manager.getWithMetadata("k1");
      expect(result.metadata).toBeNull();
    });

    it("returns null value when the key is absent (404), not request_failed", async () => {
      mockValuesGet.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
      mockMetadataGet.mockResolvedValue(null);
      expect(await manager.getWithMetadata("k1")).toEqual({ value: null, metadata: null });
    });
  });

  describe("batchSet", () => {
    it("sets all operations and reports success", async () => {
      mockValuesUpdate.mockResolvedValue(undefined);
      const results = await manager.batchSet([
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ]);
      expect(results).toEqual([
        { key: "k1", success: true },
        { key: "k2", success: true },
      ]);
    });

    it("captures per-key errors without failing the whole batch", async () => {
      mockValuesUpdate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("quota"));
      const results = await manager.batchSet([
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ]);
      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBe(false);
      expect(results[1]?.error).toContain("quota");
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the namespace is reachable", async () => {
      mockNamespacesGet.mockResolvedValue({ id: "ns-123" });
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when the namespace is not reachable", async () => {
      mockNamespacesGet.mockRejectedValue(new Error("Unauthorized"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockValuesGet.mockRejectedValue("a bare string, not an Error");
    await expect(manager.get("k1")).rejects.toBeInstanceOf(PithyError);
  });
});
