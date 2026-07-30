// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareD1Manager } from "./d1Manager";

const mockQuery = vi.fn();
const mockGet = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    d1 = {
      database: { query: mockQuery, raw: vi.fn(), get: mockGet },
    };
  },
}));

function mockQueryResponse(results: unknown[], meta?: Record<string, unknown>) {
  return { result: [{ results, meta: { duration: 1, ...meta }, success: true }] };
}

describe("CloudflareD1Manager", () => {
  const config = { accountId: "acct-1", apiToken: "tok-1", databaseId: "db-1" };
  let manager: CloudflareD1Manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareD1Manager(config);
  });

  describe("constructor and info", () => {
    it("reports service type and D1 info", () => {
      expect(manager.getServiceType()).toBe("D1 Database");
      expect(manager.getD1Info()).toEqual({ databaseId: "db-1", accountId: "acct-1" });
    });

    it("throws cloudflare/not_configured when databaseId is missing", () => {
      expect(() => new CloudflareD1Manager({ accountId: "a", apiToken: "t", databaseId: "" })).toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "cloudflare/not_configured" }) }),
      );
    });
  });

  describe("exec", () => {
    it("returns count and duration from the REST result", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ a: 1 }, { a: 2 }], { duration: 7 }));
      expect(await manager.exec("DELETE FROM users")).toEqual({ count: 2, duration: 7 });
      expect(mockQuery).toHaveBeenCalledWith("db-1", { account_id: "acct-1", sql: "DELETE FROM users" });
    });

    it("wraps an SDK failure as a PithyError", async () => {
      mockQuery.mockRejectedValue(new Error("boom"));
      await expect(manager.exec("SELECT 1")).rejects.toBeInstanceOf(PithyError);
    });
  });

  describe("batchQueries", () => {
    it("collects per-query results without failing the batch on one error", async () => {
      mockQuery.mockResolvedValueOnce(mockQueryResponse([{ id: 1 }])).mockRejectedValueOnce(new Error("syntax error"));
      const results = await manager.batchQueries([{ sql: "SELECT 1" }, { sql: "BAD" }]);
      expect(results[0]).toMatchObject({ query: "SELECT 1", success: true });
      expect(results[1]?.success).toBe(false);
      expect(results[1]?.error).toContain("syntax error");
    });
  });

  describe("listTables", () => {
    it("returns table names from sqlite_master", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ name: "users" }, { name: "posts" }, { other: "x" }]));
      expect(await manager.listTables()).toEqual(["users", "posts"]);
    });
  });

  describe("getTableSchema", () => {
    it("reads column info for a valid identifier", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ name: "id", type: "INTEGER" }]));
      expect(await manager.getTableSchema("pithy_auth_users")).toEqual([{ name: "id", type: "INTEGER" }]);
      expect(mockQuery).toHaveBeenCalledWith("db-1", {
        account_id: "acct-1",
        sql: "PRAGMA table_info(pithy_auth_users)",
      });
    });

    it("rejects a non-identifier table name before issuing any query (no SQL injection)", async () => {
      await expect(manager.getTableSchema("users); DROP TABLE secrets --")).rejects.toThrowError(
        expect.objectContaining({ payload: expect.objectContaining({ code: "validation/invalid_input" }) }),
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("unsupported binding-only methods", () => {
    it("dump() throws a PithyError", async () => {
      await expect(manager.dump()).rejects.toBeInstanceOf(PithyError);
    });

    it("withSession() throws a PithyError", () => {
      expect(() => manager.withSession()).toThrowError(PithyError);
    });
  });

  describe("validateServiceAccess", () => {
    it("returns true when the database record is reachable", async () => {
      mockGet.mockResolvedValue({ uuid: "db-1" });
      expect(await manager.validateServiceAccess()).toBe(true);
    });

    it("returns false when the database is not reachable", async () => {
      mockGet.mockRejectedValue(new Error("not found"));
      expect(await manager.validateServiceAccess()).toBe(false);
    });
  });
});
