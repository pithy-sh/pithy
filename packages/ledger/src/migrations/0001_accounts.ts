import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

/**
 * The ledger's tables: accounts, the append-only transaction log, and holds.
 *
 * camelCase identifiers; `CamelCasePlugin` snake-cases them in the DDL. `down` is the tested inverse.
 *
 * The load-bearing detail is the `CHECK` constraint on accounts: `balance >= 0 AND held >= 0 AND held <=
 * balance`. It is the overdraft guard, enforced by SQLite itself — a debit past zero or a hold past the
 * available balance violates it, which aborts the statement (and, inside a `DB.batch`, the whole
 * transaction), so the ledger cannot record a spend it cannot cover. Correctness lives in the schema, not
 * in a hopeful application-level check that a race could skip.
 */
export const ledger_0001_accounts: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable("pithyLedgerAccounts")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("currency", "text", (c) => c.notNull())
      .addColumn("balance", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("held", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("updatedAt", "integer", (c) => c.notNull())
      // One account per player per currency — the upsert-on-open conflict target.
      .addUniqueConstraint("pithyLedgerAccountsOwnerIdx", ["userId", "currency"])
      // The overdraft guard: never negative, never over-reserved. SQLite aborts any statement that breaks it.
      .addCheckConstraint("pithyLedgerAccountsSolvent", sql`balance >= 0 AND held >= 0 AND held <= balance`)
      .execute();

    await db.schema
      .createTable("pithyLedgerTransactions")
      .addColumn("id", "integer", (c) => c.primaryKey())
      // ref is UNIQUE across the whole ledger — the idempotency anchor. A replay's insert violates it, which
      // aborts the retry's batch, so the movement applies exactly once.
      .addColumn("ref", "text", (c) => c.notNull().unique())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("currency", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("amount", "integer", (c) => c.notNull())
      .addColumn("relatedRef", "text")
      .addColumn("memo", "text")
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .execute();

    // The audit read: a player's history in a currency, newest first.
    await db.schema
      .createIndex("pithyLedgerTransactionsOwnerIdx")
      .on("pithyLedgerTransactions")
      .columns(["userId", "currency", "id"])
      .execute();

    await db.schema
      .createTable("pithyLedgerHolds")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("ref", "text", (c) => c.notNull().unique())
      .addColumn("userId", "text", (c) => c.notNull())
      .addColumn("currency", "text", (c) => c.notNull())
      .addColumn("amount", "integer", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("open"))
      .addColumn("createdAt", "integer", (c) => c.notNull())
      .addColumn("resolvedAt", "integer")
      .execute();
  },
  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable("pithyLedgerHolds").execute();
    await db.schema.dropIndex("pithyLedgerTransactionsOwnerIdx").execute();
    await db.schema.dropTable("pithyLedgerTransactions").execute();
    await db.schema.dropTable("pithyLedgerAccounts").execute();
  },
};
