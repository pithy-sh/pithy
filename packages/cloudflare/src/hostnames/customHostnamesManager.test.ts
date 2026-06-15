import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareCustomHostnamesManager } from "./customHostnamesManager";

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockDelete = vi.fn();
const mockGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    customHostnames = {
      create: mockCreate,
      list: mockList,
      delete: mockDelete,
      get: mockGet,
    };
  },
}));

/** Turn an array into the async iterable the SDK's `list` returns (V4 page pagination). */
function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/** A list call that rejects only once the consumer starts iterating. */
function rejectingIterable(error: unknown): AsyncIterable<unknown> {
  return {
    // biome-ignore lint/correctness/useYield: a generator that only throws is intentional here.
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

describe("CloudflareCustomHostnamesManager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1", zoneId: "zone-9" };
  let manager: CloudflareCustomHostnamesManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareCustomHostnamesManager(config);
  });

  describe("constructor and info", () => {
    it("reports its service type and custom hostnames info", () => {
      expect(manager.getServiceType()).toBe("Cloudflare Custom Hostnames");
      expect(manager.getCustomHostnamesInfo()).toEqual({ zoneId: "zone-9", accountId: "acct-1" });
    });

    it("throws a configured PithyError when zoneId is missing", () => {
      expect(() => new CloudflareCustomHostnamesManager({ accountId: "a", apiToken: "t", zoneId: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws when apiToken is missing (base guard)", () => {
      expect(
        () => new CloudflareCustomHostnamesManager({ accountId: "a", apiToken: "", zoneId: "zone-9" }),
      ).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });

    it("throws when accountId is missing (base guard)", () => {
      expect(
        () => new CloudflareCustomHostnamesManager({ accountId: "", apiToken: "t", zoneId: "zone-9" }),
      ).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("addCustomHostname", () => {
    it("creates a hostname with HTTP DCV and a DV cert, defaulting min TLS to 1.2", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      mockCreate.mockResolvedValue({ id: "ch-1", hostname: "app.example.com" });

      const result = await manager.addCustomHostname("app.example.com");

      expect(result).toEqual({ id: "ch-1", hostname: "app.example.com" });
      expect(mockCreate).toHaveBeenCalledWith({
        zone_id: "zone-9",
        hostname: "app.example.com",
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      });
    });

    it("honors an explicit minimum TLS version", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      mockCreate.mockResolvedValue({ id: "ch-1", hostname: "app.example.com" });

      await manager.addCustomHostname("app.example.com", { minTlsVersion: "1.3" });

      expect(mockCreate).toHaveBeenCalledWith({
        zone_id: "zone-9",
        hostname: "app.example.com",
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.3" } },
      });
    });

    it("is idempotent: returns the existing hostname without creating a duplicate", async () => {
      mockList.mockReturnValue(asyncIterable([{ id: "ch-existing", hostname: "app.example.com" }]));

      const result = await manager.addCustomHostname("app.example.com");

      expect(result).toEqual({ id: "ch-existing", hostname: "app.example.com" });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("wraps an SDK create failure as cloudflare/request_failed with the cause in detail", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      mockCreate.mockRejectedValue(new Error("rate limited"));

      await expect(manager.addCustomHostname("app.example.com")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "rate limited" }),
        }),
      );
    });
  });

  describe("getCustomHostname", () => {
    it("returns the matching hostname from the listing", async () => {
      mockList.mockReturnValue(
        asyncIterable([
          { id: "ch-1", hostname: "other.example.com" },
          { id: "ch-2", hostname: "app.example.com" },
        ]),
      );

      const result = await manager.getCustomHostname("app.example.com");

      expect(result).toEqual({ id: "ch-2", hostname: "app.example.com" });
      expect(mockList).toHaveBeenCalledWith({ zone_id: "zone-9", hostname: "app.example.com" });
    });

    it("returns null when no hostname matches", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      expect(await manager.getCustomHostname("missing.example.com")).toBeNull();
    });

    it("wraps an SDK list failure as cloudflare/request_failed", async () => {
      mockList.mockReturnValue(rejectingIterable(new Error("zone unreachable")));
      await expect(manager.getCustomHostname("app.example.com")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "zone unreachable" }),
        }),
      );
    });
  });

  describe("getCustomHostnameById", () => {
    it("fetches a hostname by id", async () => {
      mockGet.mockResolvedValue({ id: "ch-7", hostname: "app.example.com" });
      const result = await manager.getCustomHostnameById("ch-7");
      expect(result).toEqual({ id: "ch-7", hostname: "app.example.com" });
      expect(mockGet).toHaveBeenCalledWith("ch-7", { zone_id: "zone-9" });
    });

    it("wraps an SDK get failure as cloudflare/request_failed", async () => {
      mockGet.mockRejectedValue(new Error("not found"));
      await expect(manager.getCustomHostnameById("ch-7")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/request_failed" }) }),
      );
    });
  });

  describe("listCustomHostnames", () => {
    it("collects every hostname on the zone", async () => {
      mockList.mockReturnValue(
        asyncIterable([
          { id: "ch-1", hostname: "a.example.com" },
          { id: "ch-2", hostname: "b.example.com" },
        ]),
      );

      const result = await manager.listCustomHostnames();

      expect(result).toEqual([
        { id: "ch-1", hostname: "a.example.com" },
        { id: "ch-2", hostname: "b.example.com" },
      ]);
      expect(mockList).toHaveBeenCalledWith({ zone_id: "zone-9" });
    });

    it("returns an empty array when there are no hostnames", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      expect(await manager.listCustomHostnames()).toEqual([]);
    });
  });

  describe("removeCustomHostname", () => {
    it("deletes a hostname by id via the REST API", async () => {
      mockDelete.mockResolvedValue({ id: "ch-3" });
      const result = await manager.removeCustomHostname("ch-3");
      expect(result).toEqual({ id: "ch-3" });
      expect(mockDelete).toHaveBeenCalledWith("ch-3", { zone_id: "zone-9" });
    });

    it("wraps an SDK delete failure as cloudflare/request_failed", async () => {
      mockDelete.mockRejectedValue(new Error("conflict"));
      await expect(manager.removeCustomHostname("ch-3")).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "conflict" }),
        }),
      );
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the zone's hostnames are reachable", async () => {
      mockList.mockReturnValue(asyncIterable([{ id: "ch-1", hostname: "a.example.com" }]));
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns true even when the zone has no hostnames", async () => {
      mockList.mockReturnValue(asyncIterable([]));
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when the listing fails", async () => {
      mockList.mockReturnValue(rejectingIterable(new Error("Unauthorized")));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });

  it("only ever throws PithyError from public methods", async () => {
    mockGet.mockRejectedValue("a bare string, not an Error");
    await expect(manager.getCustomHostnameById("ch-7")).rejects.toBeInstanceOf(PithyError);
  });
});
