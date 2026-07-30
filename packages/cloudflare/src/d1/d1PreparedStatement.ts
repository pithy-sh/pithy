// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Cloudflare } from "cloudflare";
import type { QueryResult } from "cloudflare/resources/d1/database";
import { cloudflareRequest } from "../client/errors";

/**
 * A `D1PreparedStatement` backed by the D1 REST API instead of a Worker binding. It mirrors the
 * binding's prepared-statement surface (`bind`/`run`/`all`/`first`/`raw`) closely enough that a
 * Kysely `D1Dialect` (kysely-d1) can drive it unchanged — which is how `pithy migrate` runs the
 * same query builder from a CLI/CI context against D1 over REST (issue #31).
 *
 * `D1PreparedStatement`/`D1Result`/`D1Meta` are the ambient `@cloudflare/workers-types` shapes, so
 * this class is structurally a drop-in for the binding's statement.
 */
function mapMeta(restMeta?: QueryResult.Meta): D1Meta & Record<string, unknown> {
  return {
    duration: restMeta?.duration ?? 0,
    size_after: restMeta?.size_after ?? 0,
    rows_read: restMeta?.rows_read ?? 0,
    rows_written: restMeta?.rows_written ?? 0,
    last_row_id: restMeta?.last_row_id ?? 0,
    changed_db: restMeta?.changed_db ?? false,
    changes: restMeta?.changes ?? 0,
  };
}

/** The REST `params` array is strings; coerce each bound value the way the D1 REST API expects. */
function toStringParams(params: unknown[]): string[] {
  return params.map((value) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    return JSON.stringify(value);
  });
}

export class D1PreparedStatementREST<T = Record<string, unknown>> implements D1PreparedStatement {
  private readonly sql: string;

  private readonly boundParams: unknown[];

  private readonly client: Cloudflare;

  private readonly accountId: string;

  private readonly databaseId: string;

  constructor(sql: string, client: Cloudflare, accountId: string, databaseId: string, boundParams: unknown[] = []) {
    this.sql = sql;
    this.boundParams = boundParams;
    this.client = client;
    this.accountId = accountId;
    this.databaseId = databaseId;
  }

  /** Bind positional parameters, returning a new statement (the binding's immutable contract). */
  bind(...values: unknown[]): D1PreparedStatementREST<T> {
    return new D1PreparedStatementREST<T>(this.sql, this.client, this.accountId, this.databaseId, values);
  }

  run<U = T>(): Promise<D1Result<U>> {
    return this.executeQuery<U>();
  }

  all<U = T>(): Promise<D1Result<U>> {
    return this.executeQuery<U>();
  }

  async first<U = unknown>(colName: string): Promise<U | null>;
  async first<U = T>(): Promise<U | null>;
  async first<U = unknown>(colName?: string): Promise<U | null> {
    const result = await this.executeQuery<Record<string, unknown>>();
    const row = result.results[0] ?? null;
    if (row === null) return null;
    if (colName) return (row[colName] as U) ?? null;
    return row as U;
  }

  async raw<U = unknown[]>(options: { columnNames: true }): Promise<[string[], ...U[]]>;
  async raw<U = unknown[]>(options?: { columnNames?: false }): Promise<U[]>;
  async raw<U = unknown[]>(options?: { columnNames?: boolean }): Promise<U[] | [string[], ...U[]]> {
    const params = this.boundParams.length > 0 ? toStringParams(this.boundParams) : undefined;
    const response = await cloudflareRequest("D1 raw query", () =>
      this.client.d1.database.raw(this.databaseId, { account_id: this.accountId, sql: this.sql, params }),
    );
    const rawResult = response.result[0];
    const rows = (rawResult?.results?.rows ?? []) as U[];
    if (options?.columnNames) {
      const columns = rawResult?.results?.columns ?? [];
      return [columns, ...rows];
    }
    return rows;
  }

  private async executeQuery<U>(): Promise<D1Result<U>> {
    const params = this.boundParams.length > 0 ? toStringParams(this.boundParams) : undefined;
    const response = await cloudflareRequest("D1 query", () =>
      this.client.d1.database.query(this.databaseId, { account_id: this.accountId, sql: this.sql, params }),
    );
    const queryResult = response.result[0];
    return {
      success: true,
      meta: mapMeta(queryResult?.meta),
      results: (queryResult?.results ?? []) as U[],
    };
  }
}
