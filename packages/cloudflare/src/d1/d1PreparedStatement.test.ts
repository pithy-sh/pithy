// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareD1Manager } from "./d1Manager";

const mockQuery = vi.fn();
const mockRaw = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    d1 = {
      database: { query: mockQuery, raw: mockRaw, get: vi.fn() },
    };
  },
}));

function mockQueryResponse(results: unknown[], meta?: Record<string, unknown>) {
  return {
    result: [
      {
        results,
        meta: { duration: 1, changes: 0, rows_read: results.length, rows_written: 0, ...meta },
        success: true,
      },
    ],
  };
}

function mockRawResponse(columns: string[], rows: unknown[][]) {
  return { result: [{ results: { columns, rows }, meta: { duration: 1 }, success: true }] };
}

describe("D1PreparedStatementREST", () => {
  let manager: CloudflareD1Manager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CloudflareD1Manager({
      accountId: "test-account-id",
      apiToken: "test-api-token",
      databaseId: "test-db-id",
    });
  });

  describe("prepare", () => {
    it("returns a statement with the binding's method surface", () => {
      const stmt = manager.prepare("SELECT 1");
      expect(typeof stmt.bind).toBe("function");
      expect(typeof stmt.run).toBe("function");
      expect(typeof stmt.all).toBe("function");
      expect(typeof stmt.first).toBe("function");
      expect(typeof stmt.raw).toBe("function");
    });
  });

  describe("bind", () => {
    it("returns a new immutable statement instance", () => {
      const stmt = manager.prepare("SELECT * FROM users WHERE id = ?");
      expect(stmt.bind("user-1")).not.toBe(stmt);
    });

    it("passes bound params to the REST API", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([]));
      await manager.prepare("SELECT * FROM users WHERE id = ?").bind("user-1").run();
      expect(mockQuery).toHaveBeenCalledWith("test-db-id", {
        account_id: "test-account-id",
        sql: "SELECT * FROM users WHERE id = ?",
        params: ["user-1"],
      });
    });

    it("coerces non-string params to strings", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([]));
      await manager.prepare("SELECT ?").bind(42, true, null).run();
      expect(mockQuery).toHaveBeenCalledWith("test-db-id", {
        account_id: "test-account-id",
        sql: "SELECT ?",
        params: ["42", "true", ""],
      });
    });

    it("sends no params when bind is not called", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([]));
      await manager.prepare("SELECT 1").run();
      expect(mockQuery).toHaveBeenCalledWith("test-db-id", {
        account_id: "test-account-id",
        sql: "SELECT 1",
        params: undefined,
      });
    });
  });

  describe("run", () => {
    it("returns a D1Result with results and meta", async () => {
      const rows = [{ id: 1, name: "Alice" }];
      mockQuery.mockResolvedValue(mockQueryResponse(rows, { duration: 5, changes: 1 }));
      const result = await manager.prepare("INSERT INTO users VALUES (1, 'Alice')").run();
      expect(result.success).toBe(true);
      expect(result.results).toEqual(rows);
      expect(result.meta.duration).toBe(5);
      expect(result.meta.changes).toBe(1);
    });

    it("defaults every meta field when the API returns none", async () => {
      mockQuery.mockResolvedValue({ result: [{ results: [], success: true }] });
      const result = await manager.prepare("SELECT 1").run();
      expect(result.meta).toMatchObject({ duration: 0, changes: 0, rows_read: 0, changed_db: false });
    });

    it("wraps an API error as a PithyError (cloudflare/request_failed)", async () => {
      mockQuery.mockRejectedValue(new Error("Network failure"));
      await expect(manager.prepare("SELECT 1").run()).rejects.toThrowError(
        expect.objectContaining({
          payload: expect.objectContaining({ code: "cloudflare/request_failed", detail: "Network failure" }),
        }),
      );
    });
  });

  describe("first", () => {
    it("returns the first row", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ id: 1, name: "Alice" }]));
      expect(await manager.prepare("SELECT * FROM users LIMIT 1").first()).toEqual({ id: 1, name: "Alice" });
    });

    it("returns null when there are no rows", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([]));
      expect(await manager.prepare("SELECT * FROM users WHERE id = 999").first()).toBeNull();
    });

    it("returns a single column value", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ id: 1, name: "Alice" }]));
      expect(await manager.prepare("SELECT * FROM users LIMIT 1").first("name")).toBe("Alice");
    });

    it("returns null for a missing column", async () => {
      mockQuery.mockResolvedValue(mockQueryResponse([{ id: 1 }]));
      expect(await manager.prepare("SELECT * FROM users LIMIT 1").first("nope")).toBeNull();
    });
  });

  describe("raw", () => {
    it("returns raw array rows", async () => {
      mockRaw.mockResolvedValue(
        mockRawResponse(
          ["id", "name"],
          [
            [1, "Alice"],
            [2, "Bob"],
          ],
        ),
      );
      expect(await manager.prepare("SELECT * FROM users").raw()).toEqual([
        [1, "Alice"],
        [2, "Bob"],
      ]);
    });

    it("prepends column names when requested", async () => {
      mockRaw.mockResolvedValue(mockRawResponse(["id", "name"], [[1, "Alice"]]));
      const result = await manager.prepare("SELECT * FROM users").raw({ columnNames: true });
      expect(result[0]).toEqual(["id", "name"]);
      expect(result[1]).toEqual([1, "Alice"]);
    });
  });

  it("only ever throws PithyError from execution", async () => {
    mockQuery.mockRejectedValue("a bare string");
    await expect(manager.prepare("SELECT 1").run()).rejects.toBeInstanceOf(PithyError);
  });
});
