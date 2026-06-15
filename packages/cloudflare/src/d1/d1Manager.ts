import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { D1 } from "cloudflare/resources/d1/d1";
import type { QueryResult } from "cloudflare/resources/d1/database";
import { CloudflareNotConfiguredError, cloudflareRequest, reasonOf } from "../client/errors";
import { CloudflareManager, type CloudflareManagerConfig } from "../client/manager";
import { D1PreparedStatementREST } from "./d1PreparedStatement";

/** Config for the D1 manager: the shared client config plus the database it targets. */
export interface D1ManagerConfig extends CloudflareManagerConfig {
  /** The D1 database id (the REST API addresses databases by id). */
  databaseId: string;
}

/** The per-query outcome of `batchQueries`: a partial-failure report, never a thrown batch. */
export interface D1BatchResult {
  /** The SQL this result is for. */
  query: string;
  /** Whether the query returned at least one result set. */
  success: boolean;
  /** The result sets, present only on success. */
  result?: QueryResult[];
  /** The failure reason, present only when `success` is false. */
  error?: string;
}

/**
 * Out-of-Worker D1 access over the REST API. It `implements D1Database`, so the same query builder
 * a Worker runs against a binding runs from a CLI/CI context against D1 over REST — most
 * importantly as the database behind a Kysely `D1Dialect` (kysely-d1), which is how `pithy migrate`
 * promotes/rolls back schema remotely (issue #31). Inside a Worker you use the `D1Database` binding
 * directly; this is the REST counterpart, addressed by database id.
 */
export class CloudflareD1Manager extends CloudflareManager implements D1Database {
  private readonly databaseId: string;

  constructor(config: D1ManagerConfig) {
    super(config);
    if (!config.databaseId) {
      throw new CloudflareNotConfiguredError({ detail: "Missing databaseId for D1 REST access." });
    }
    this.databaseId = config.databaseId;
  }

  // --- D1Database surface (what Kysely's D1Dialect drives) ---

  prepare(query: string): D1PreparedStatement {
    return new D1PreparedStatementREST(query, this.getClient(), this.accountId, this.databaseId);
  }

  /**
   * Run each statement and collect its result. **Not atomic:** unlike the Worker binding's `batch()`
   * (which runs the statements in one transaction), the D1 REST API exposes no batch/transaction
   * endpoint, so these execute as independent sequential queries — a mid-batch failure leaves earlier
   * statements committed. D1 has no interactive transactions, and Kysely drives migrations through
   * `prepare().all()` per statement rather than this method, so this affects only direct callers.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await (statement as D1PreparedStatementREST<T>).run<T>());
    }
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    const response = await cloudflareRequest("D1 exec", () =>
      this.getClient().d1.database.query(this.databaseId, { account_id: this.accountId, sql: query }),
    );
    const result = response.result[0];
    return { count: result?.results?.length ?? 0, duration: result?.meta?.duration ?? 0 };
  }

  /** `dump()` is deprecated and has no REST equivalent — calling it is a programming error. */
  async dump(): Promise<ArrayBuffer> {
    throw new InternalError({ detail: "D1 dump() is not supported via the REST client." });
  }

  /** Sessions are a binding-only feature; the REST client has no equivalent. */
  withSession(): never {
    throw new InternalError({ detail: "D1 withSession() is not supported via the REST client." });
  }

  // --- REST convenience methods ---

  /** Run one SQL statement and return its raw REST result sets. */
  async executeQuery(sql: string, params?: string[]): Promise<QueryResult[]> {
    const response = await cloudflareRequest("D1 query", () =>
      this.getClient().d1.database.query(this.databaseId, { account_id: this.accountId, sql, params }),
    );
    return response.result;
  }

  /**
   * Run many independent queries, collecting a per-query result instead of failing the whole batch
   * on the first error — the caller decides what to do with partial failure.
   */
  async batchQueries(queries: Array<{ sql: string; params?: string[] }>): Promise<D1BatchResult[]> {
    return Promise.all(
      queries.map(async (query): Promise<D1BatchResult> => {
        try {
          const result = await this.executeQuery(query.sql, query.params);
          return { query: query.sql, success: result.length > 0, result };
        } catch (error) {
          return { query: query.sql, success: false, error: reasonOf(error) };
        }
      }),
    );
  }

  /** Fetch the D1 database record. */
  async getDatabaseInfo(): Promise<D1> {
    return cloudflareRequest("get D1 database info", () =>
      this.getClient().d1.database.get(this.databaseId, { account_id: this.accountId }),
    );
  }

  /** List the user tables in the database. */
  async listTables(): Promise<string[]> {
    const result = await this.executeQuery("SELECT name FROM sqlite_master WHERE type='table'");
    return result
      .flatMap((queryResult) => (queryResult.results ?? []) as unknown[])
      .map((row) => (isNamedRow(row) ? row.name : undefined))
      .filter((name): name is string => typeof name === "string");
  }

  /**
   * Read a table's column schema via `PRAGMA table_info`. SQLite pragmas take no bind parameters, so
   * the table name is interpolated — guard it against a strict identifier allowlist first, so the one
   * un-parameterized SQL path in this client can never become an injection sink.
   */
  async getTableSchema(tableName: string): Promise<unknown[]> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      throw new ValidationError({
        message: "Invalid table name.",
        detail: `Table name must be a plain SQL identifier, got: ${tableName}`,
      });
    }
    const result = await this.executeQuery(`PRAGMA table_info(${tableName})`);
    return result.flatMap((queryResult) => (queryResult.results ?? []) as unknown[]);
  }

  /** The database this manager targets and the account it lives in. */
  getD1Info(): { databaseId: string; accountId: string } {
    return { databaseId: this.databaseId, accountId: this.accountId };
  }

  getServiceType(): string {
    return "D1 Database";
  }

  /** Prove access by reading the database record. Never throws. */
  async validateServiceAccess(): Promise<boolean> {
    try {
      await this.getDatabaseInfo();
      return true;
    } catch {
      return false;
    }
  }
}

/** Narrow a result row to one carrying a string `name` column (the `sqlite_master` shape). */
function isNamedRow(row: unknown): row is { name: string } {
  return (
    typeof row === "object" && row !== null && "name" in row && typeof (row as { name: unknown }).name === "string"
  );
}
