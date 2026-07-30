// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareD1Manager } from "./d1Manager";

/**
 * The keystone for #31: prove `CloudflareD1Manager` is a drop-in `D1Database` for kysely-d1's
 * `D1Dialect`, so the same Kysely query builder a Worker runs against a binding runs from a
 * CLI/CI context against D1 over REST. kysely-d1 calls `database.prepare(sql).bind(...params).all()`
 * and reads `results.meta` / `results.results` — exactly the surface this manager implements.
 */

const mockQuery = vi.fn();

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    d1 = {
      database: { query: mockQuery, raw: vi.fn(), get: vi.fn() },
    };
  },
}));

interface TestDatabase {
  users: { id: number; name: string };
}

describe("CloudflareD1Manager as a Kysely D1Dialect database", () => {
  let db: Kysely<TestDatabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    const manager = new CloudflareD1Manager({ accountId: "acct-1", apiToken: "tok-1", databaseId: "db-1" });
    db = new Kysely<TestDatabase>({ dialect: new D1Dialect({ database: manager }) });
  });

  it("compiles and executes a SELECT through the REST API, returning rows", async () => {
    mockQuery.mockResolvedValue({
      result: [{ results: [{ id: 1, name: "Alice" }], meta: { changes: 0, last_row_id: 0 }, success: true }],
    });

    const rows = await db.selectFrom("users").selectAll().where("id", "=", 1).execute();

    expect(rows).toEqual([{ id: 1, name: "Alice" }]);
    expect(mockQuery).toHaveBeenCalledWith("db-1", {
      account_id: "acct-1",
      sql: 'select * from "users" where "id" = ?',
      params: ["1"],
    });
  });

  it("surfaces insertId and affected rows from D1 meta on a write", async () => {
    mockQuery.mockResolvedValue({
      result: [{ results: [], meta: { changes: 1, last_row_id: 42 }, success: true }],
    });

    const result = await db.insertInto("users").values({ id: 42, name: "Bob" }).executeTakeFirst();

    expect(result?.insertId).toBe(42n);
    expect(result?.numInsertedOrUpdatedRows).toBe(1n);
    expect(mockQuery).toHaveBeenCalledWith("db-1", {
      account_id: "acct-1",
      sql: 'insert into "users" ("id", "name") values (?, ?)',
      params: ["42", "Bob"],
    });
  });
});
