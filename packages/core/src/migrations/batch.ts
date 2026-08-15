// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult, TransactionSettings } from "kysely";
import { CamelCasePlugin, Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { D1MigrationDialect } from "./bookkeeping";

/**
 * **One round trip per migration, instead of one per statement.**
 *
 * `kysely-d1` executes every compiled query as its own `prepare().bind().all()`, so a capability's
 * `0001_init` — nineteen tables and thirty-eight indexes, composed — cost fifty-seven hops to D1.
 * Measured against a real composed application in the Workers runtime: 1,028ms and 68 round trips to
 * migrate, 2,041ms per drop-and-rebuild. An adopter following the kit's own advice (Workers-runtime
 * tests against real D1, not mocks) pays that once per test that needs a clean database; in
 * `pithy-sh/dashboard` it was 78% of total wall time, and the setup floor it left put ordinary test
 * bodies within reach of the 5,000ms timeout (`pithy-sh/pithy#368`).
 *
 * `d1.batch()` sends many statements in one round trip, in order, in one implicit transaction. A
 * migration's statements are already ordered and already a unit, which is the shape `batch` exists
 * for. So a migration body runs against a Kysely whose driver **queues** its statements and sends
 * them as one batch when the body returns.
 *
 * ## Only DDL is queued, and that is the whole safety argument
 *
 * A queued statement's result is returned to the migration body before the statement has run, so it
 * cannot carry rows, a row count, or an insert id. Rather than document that as a caveat, the queue
 * only takes statements that **have no such result to carry** — `create`/`drop`/`alter` on a table,
 * index, view, schema or type. Everything else — every select, insert, update, delete, and every raw
 * `sql` template, whose shape is not knowable from its node — **flushes the queue and then executes
 * on its own**, exactly as before. Ordering is therefore preserved unconditionally: a read always
 * sees every statement written before it.
 *
 * The consequence worth stating: a migration that interleaves data with DDL is split into several
 * batches, one per run of consecutive DDL. It is still correct and still faster; it is simply not one
 * transaction. Every migration the kit ships is pure DDL and is one batch.
 *
 * ## Failure semantics, which did change
 *
 * Before: a migration failing at its k-th statement left statements 1..k-1 applied, with no ledger
 * row — a half-applied migration, the thing a chain exists to prevent. After: the batch is the unit,
 * so a failure anywhere in it rolls back all of it and the ledger still records nothing. The
 * migration is all-or-nothing.
 *
 * What did **not** change is anything across a migration boundary. Each `up`/`down` builds its own
 * queue and flushes before returning, so no statement of one migration can share a batch with
 * another's, and the ledger row is written by Kysely's `Migrator` on the ordinary path afterwards.
 * A chain that fails at its third migration still has its first two applied and recorded, and the
 * error still names them. Batching across migrations would make a partial chain unrepresentable in
 * the ledger, which is worse than slow.
 */

/**
 * Compiled-query kinds with no result a migration body could read — the only ones safe to queue.
 * SQLite ignores schemas and types, but the nodes exist and cost nothing to name.
 */
const QUEUEABLE_KINDS: ReadonlySet<string> = new Set([
  "CreateTableNode",
  "DropTableNode",
  "CreateIndexNode",
  "DropIndexNode",
  "AlterTableNode",
  "CreateViewNode",
  "DropViewNode",
  "CreateSchemaNode",
  "DropSchemaNode",
  "CreateTypeNode",
  "DropTypeNode",
]);

/** Statements waiting for their one round trip. Ordered; flushed as a single `d1.batch()`. */
class StatementQueue {
  readonly #database: D1Database;
  #pending: CompiledQuery[] = [];

  constructor(database: D1Database) {
    this.#database = database;
  }

  add(query: CompiledQuery): void {
    this.#pending.push(query);
  }

  /**
   * Send everything queued, in order, as one batch — and nothing at all when nothing is queued, so a
   * flush is always safe to call. Cleared before the call, so a failed batch is not retried by a
   * later flush.
   */
  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const pending = this.#pending;
    this.#pending = [];
    const statements: D1PreparedStatement[] = pending.map((query) =>
      this.#database.prepare(query.sql).bind(...query.parameters),
    );
    await this.#database.batch(statements);
  }
}

/** Queues what it can, and flushes before anything it cannot — see the module note. */
class QueueingConnection implements DatabaseConnection {
  readonly #direct: DatabaseConnection;
  readonly #queue: StatementQueue;

  constructor(direct: DatabaseConnection, queue: StatementQueue) {
    this.#direct = direct;
    this.#queue = queue;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (QUEUEABLE_KINDS.has(query.query.kind)) {
      this.#queue.add(query);
      return { rows: [] };
    }
    await this.#queue.flush();
    return this.#direct.executeQuery<R>(query);
  }

  streamQuery<R>(query: CompiledQuery, chunkSize: number): AsyncIterableIterator<QueryResult<R>> {
    return this.#direct.streamQuery<R>(query, chunkSize);
  }
}

/** The stock D1 driver, with every connection wrapped in the queue. Transactions stay unsupported. */
class QueueingDriver implements Driver {
  readonly #inner: Driver;
  readonly #queue: StatementQueue;
  readonly #inners = new WeakMap<DatabaseConnection, DatabaseConnection>();

  constructor(inner: Driver, queue: StatementQueue) {
    this.#inner = inner;
    this.#queue = queue;
  }

  async init(): Promise<void> {
    await this.#inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const inner = await this.#inner.acquireConnection();
    const wrapped = new QueueingConnection(inner, this.#queue);
    this.#inners.set(wrapped, inner);
    return wrapped;
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await this.#inner.beginTransaction(this.#unwrap(connection), settings);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#inner.commitTransaction(this.#unwrap(connection));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#inner.rollbackTransaction(this.#unwrap(connection));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    await this.#inner.releaseConnection(this.#unwrap(connection));
  }

  async destroy(): Promise<void> {
    await this.#inner.destroy();
  }

  #unwrap(connection: DatabaseConnection): DatabaseConnection {
    return this.#inners.get(connection) ?? connection;
  }
}

/** Pithy's D1 dialect — same compiler, same `sqlite_master`-only introspector — driving the queue. */
class QueueingD1Dialect extends D1MigrationDialect {
  readonly #queue: StatementQueue;

  constructor(database: D1Database, queue: StatementQueue) {
    super({ database });
    this.#queue = queue;
  }

  override createDriver(): Driver {
    return new QueueingDriver(super.createDriver(), this.#queue);
  }
}

/**
 * Run one migration body against a queueing Kysely and send its statements as one batch.
 *
 * The `db` Kysely's `Migrator` would have passed is deliberately not used: it is the instance that
 * also writes the ledger, and the ledger row must stay on the ordinary path so that a failed batch
 * leaves no record of having applied. Same binding, same `CamelCasePlugin`, same dialect — a
 * migration body cannot tell the difference except in how many hops it costs.
 */
async function batchBody(body: (db: Kysely<unknown>) => Promise<void>, database: D1Database): Promise<void> {
  const queue = new StatementQueue(database);
  const db = new Kysely<unknown>({ dialect: new QueueingD1Dialect(database, queue), plugins: [new CamelCasePlugin()] });
  await body(db);
  await queue.flush();
}

/** One migration, both directions batched. A migration with no `down` still has none. */
function batchMigration(migration: Migration, database: D1Database): Migration {
  const down = migration.down;
  return {
    up: async (): Promise<void> => batchBody((db) => migration.up(db), database),
    ...(down ? { down: async (): Promise<void> => batchBody((db) => down(db), database) } : {}),
  };
}

/**
 * Wrap a provider so every migration it yields applies and reverses in one round trip each.
 *
 * Applied at the runner's seam rather than inside each capability, so a migration author writes
 * ordinary Kysely and gets this for free — including adopters, who are the ones paying for it.
 */
export function batchedProvider(provider: MigrationProvider, database: D1Database): MigrationProvider {
  return {
    getMigrations: async (): Promise<Record<string, Migration>> => {
      const migrations = await provider.getMigrations();
      return Object.fromEntries(
        Object.entries(migrations).map(([name, migration]) => [name, batchMigration(migration, database)]),
      );
    },
  };
}
