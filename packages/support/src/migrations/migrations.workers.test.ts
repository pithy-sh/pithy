// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { indexMessage, reindexThread } from "../store/search";
import { createSearchIndex, dropSearchIndex } from "../store/searchIndex";
import { support_0001_threads } from "./0001_threads";

/**
 * Both migrations against real D1, up **and** down, with the FTS5 index proved to actually work
 * rather than merely created.
 *
 * The search half is the reason this file is a Workers test rather than a unit test with a fake.
 * FTS5 is a compile-time SQLite option, and "does D1 have it" is not a question a mock can answer —
 * getting it wrong would mean discovering at `pithy migrate` time, on somebody's production
 * database, that the search box the dashboard is built around cannot exist.
 */

/** Build an app-database provider for the given local migration set. */
function provider(migrations: Record<string, Migration>): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/** Every support table currently in the schema, in name order. */
async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_support_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Every support trigger currently in the schema. */
async function triggers(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'pithy_support_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Insert one message row directly, so the trigger path is exercised without the ingest code. */
async function insertMessage(options: {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  mimeMessageId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pithy_support_messages
       (id, thread_id, direction, mime_message_id, from_address, to_address, subject, text_body, received_at, created_at)
     VALUES (?, ?, 'inbound', ?, 'ada@example.com', 'support@help.example.com', ?, ?, 1, 1)`,
  )
    .bind(options.id, options.threadId, options.mimeMessageId ?? null, options.subject, options.body)
    .run();
}

/** The thread ids the full-text index returns for a query. */
async function search(term: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT thread_id FROM pithy_support_search WHERE pithy_support_search MATCH ? ORDER BY thread_id",
  )
    .bind(term)
    .all<{ thread_id: string }>();
  return results.map((row) => row.thread_id);
}

/** A valid thread, for the schema assertions above. */
const THREAD = {
  id: "t1",
  inboxAddress: "support@help.example.com",
  subject: "Hi",
  fromAddress: "ada@example.com",
  fromName: null,
  senderAuthenticated: false,
  userId: null,
  category: "billing",
  priority: "normal",
  sentiment: "neutral",
  confidence: null,
  model: null,
  classifiedAt: null,
  archived: false,
  archivedAt: null,
  archivedBy: null,
  messageCount: 1,
  firstMessageAt: new Date(1),
  lastMessageAt: new Date(1),
  createdAt: new Date(1),
  updatedAt: new Date(1),
} satisfies Parameters<typeof SupportThread.encode>[0];

const ALL = { "0001_threads": support_0001_threads };

beforeEach(async () => {
  for (const trigger of ["pithy_support_search_update", "pithy_support_search_delete", "pithy_support_search_insert"]) {
    await env.DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const table of [
    "pithy_support_search",
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
});

describe("support_0001_threads", () => {
  test("up creates all five tables", async () => {
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    expect(await tables()).toEqual([
      "pithy_support_attachments",
      "pithy_support_classifications",
      "pithy_support_messages",
      "pithy_support_thread_flags",
      "pithy_support_threads",
    ]);
  });

  test("down removes every one of them", async () => {
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    await rollbackMigration(env.DB, provider({ "0001_threads": support_0001_threads }));
    expect(await tables()).toEqual([]);
  });

  test("the message id index is unique, so a redelivered message cannot duplicate", async () => {
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    await insertMessage({ id: "m1", threadId: "t1", subject: "Hi", body: "one", mimeMessageId: "abc@mail" });
    // The whole point of the index: Email Routing redelivering is normal, and a second row is not.
    await expect(
      insertMessage({ id: "m2", threadId: "t1", subject: "Hi", body: "two", mimeMessageId: "abc@mail" }),
    ).rejects.toThrow();
  });

  test("a message with no Message-ID still stores, twice over", async () => {
    // SQLite permits repeated NULLs in a unique index, and a hand-rolled sender that omits the header
    // must not be a write failure.
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    await insertMessage({ id: "m1", threadId: "t1", subject: "Hi", body: "one", mimeMessageId: null });
    await insertMessage({ id: "m2", threadId: "t1", subject: "Hi", body: "two", mimeMessageId: null });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_support_messages").all<{ n: number }>();
    expect(results[0]?.n).toBe(2);
  });

  test("the schema refuses a priority outside the enum — the column no longer has to", async () => {
    // The CHECK constraints that used to mirror these enums are gone: CLAUDE.md's rule is that one
    // Zod schema is the entire table definition, and a second partial copy in the DDL can drift from
    // it and cannot be altered without rebuilding the table. The refusal moved, it did not vanish.
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    expect(() => SupportThread.encode({ ...THREAD, priority: "catastrophic" } as never)).toThrow();
    expect(() => SupportThread.encode({ ...THREAD, sentiment: "livid" } as never)).toThrow();
  });

  test("the schema refuses a confidence outside 0..1, which is the one bound a model can break", async () => {
    // Moved into the schema rather than dropped: `confidence` is the only value in these tables that
    // originates outside our own code.
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    expect(() => SupportThread.encode({ ...THREAD, confidence: 1.5 })).toThrow();
    expect(() => SupportThread.encode({ ...THREAD, confidence: -0.1 })).toThrow();
    expect(() => SupportThread.encode({ ...THREAD, confidence: 0.5 })).not.toThrow();
  });

  test("category is deliberately unconstrained, because the taxonomy is federated", async () => {
    // An adopter's own category must be writable without a migration. A CHECK here would make
    // `defineSupportCategories` a lie.
    await runMigrations(env.DB, provider({ "0001_threads": support_0001_threads }));
    await env.DB.prepare(
      `INSERT INTO pithy_support_threads
         (id, inbox_address, subject, from_address, category, priority, sentiment, archived,
          message_count, first_message_at, last_message_at, created_at, updated_at)
       VALUES ('t1', 'support@x', 'Hi', 'a@x', 'tournament_dispute', 'normal', 'neutral', 0, 1, 1, 1, 1, 1)`,
    ).run();
    const { results } = await env.DB.prepare("SELECT category FROM pithy_support_threads").all<{ category: string }>();
    expect(results[0]?.category).toBe("tournament_dispute");
  });
});

describe("the opt-in FTS5 index — a provisioned resource, not a migration", () => {
  test("the migration set never carries it — a config flag cannot corrupt the ledger", async () => {
    // The whole point of moving it out. Composing it conditionally on `search.fts` meant turning the
    // flag off removed an applied migration, and Kysely reads that as corruption — blocking
    // `pithy migrate` for every capability sharing the database, not just support.
    await runMigrations(env.DB, provider(ALL));
    expect(await tables()).not.toContain("pithy_support_search");
  });

  test("provisioning creates the virtual table, and no triggers", async () => {
    await runMigrations(env.DB, provider(ALL));
    await createSearchIndex(supportDatabase(env.DB));
    expect(await tables()).toContain("pithy_support_search");
    // Deliberately none. Triggers are the obvious way to keep an FTS index in step and they work in
    // Miniflare — but D1 runs an authorizer that rejects SQLite constructs workerd permits
    // (`fts5vocab` is refused on D1 while plain FTS5 succeeds), and `CREATE TRIGGER` is documented
    // neither as supported nor as refused. Passing here would have proved nothing about the
    // deployment that matters, so the index is written by application code instead.
    expect(await triggers()).toEqual([]);
  });

  test("D1 really has FTS5 — an indexed message is findable by a word in its body", async () => {
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await indexMessage(db, { threadId: "t1", messageId: "m1", subject: "Refund please", body: "I was charged twice" });
    await indexMessage(db, {
      threadId: "t2",
      messageId: "m2",
      subject: "Cannot log in",
      body: "the magic link never arrived",
    });

    expect(await search("charged")).toEqual(["t1"]);
    expect(await search("magic")).toEqual(["t2"]);
  });

  test("the subject is indexed too, not only the body", async () => {
    await runMigrations(env.DB, provider(ALL));
    await createSearchIndex(supportDatabase(env.DB));
    await indexMessage(supportDatabase(env.DB), {
      threadId: "t1",
      messageId: "m1",
      subject: "Chargeback notice",
      body: "see attached",
    });
    expect(await search("chargeback")).toEqual(["t1"]);
  });

  test("an order number survives tokenization — the reason this is keyword search", async () => {
    await runMigrations(env.DB, provider(ALL));
    await createSearchIndex(supportDatabase(env.DB));
    await indexMessage(supportDatabase(env.DB), {
      threadId: "t1",
      messageId: "m1",
      subject: "Order problem",
      body: "my order ORD-40912 never shipped",
    });
    // An embedding cannot find this. That is the argument for keyword search as the default, in two
    // assertions.
    expect(await search("ORD")).toEqual(["t1"]);
    expect(await search("40912")).toEqual(["t1"]);
  });

  test("diacritics fold, so a French customer is findable by an unaccented query", async () => {
    await runMigrations(env.DB, provider(ALL));
    await createSearchIndex(supportDatabase(env.DB));
    await indexMessage(supportDatabase(env.DB), {
      threadId: "t1",
      messageId: "m1",
      subject: "Probl\u00e8me",
      body: "la commande est annul\u00e9e",
    });
    expect(await search("probleme")).toEqual(["t1"]);
    expect(await search("annulee")).toEqual(["t1"]);
  });

  test("reindexThread rebuilds from the messages table — the repair path", async () => {
    // The failure application-side indexing has and triggers would not: a message stored while the
    // index write failed. This is what fixes it.
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await insertMessage({ id: "m1", threadId: "t1", subject: "Refund", body: "charged twice" });
    expect(await search("charged")).toEqual([]);

    expect(await reindexThread(db, "t1")).toBe(1);
    expect(await search("charged")).toEqual(["t1"]);
  });

  test("indexMessage is idempotent — a retried index write does not double-index", async () => {
    // An FTS5 table has no primary key and no unique constraint, so a bare insert would silently add
    // a second copy and the thread would appear twice in its own search results. The delete-then-
    // insert is what makes a retry, a reindex, and a first write the same operation.
    await runMigrations(env.DB, provider(ALL));
    await createSearchIndex(supportDatabase(env.DB));
    const db = supportDatabase(env.DB);
    const entry = { threadId: "t1", messageId: "m1", subject: "Refund", body: "charged twice" };

    await indexMessage(db, entry);
    await indexMessage(db, entry);

    expect(await search("charged")).toEqual(["t1"]);
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pithy_support_search WHERE message_id = 'm1'",
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  test("re-indexing a message with new text replaces its old words rather than adding to them", async () => {
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await indexMessage(db, { threadId: "t1", messageId: "m1", subject: "Refund", body: "charged twice" });
    await indexMessage(db, { threadId: "t1", messageId: "m1", subject: "Refund", body: "resolved happily" });

    expect(await search("charged")).toEqual([]);
    expect(await search("resolved")).toEqual(["t1"]);
  });

  test("reindexThread is idempotent — running it twice does not double-index", async () => {
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await insertMessage({ id: "m1", threadId: "t1", subject: "Refund", body: "charged twice" });
    await reindexThread(db, "t1");
    await reindexThread(db, "t1");

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pithy_support_search WHERE thread_id = 't1'",
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  test("dropSearchIndex removes it and leaves the message tables alone", async () => {
    // Turning `search.fts` back off is now this — one idempotent statement from a re-provision —
    // rather than a migration rollback that has to happen before the config edit or the whole
    // database's migration set reads as corrupt.
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await dropSearchIndex(db);

    expect(await tables()).not.toContain("pithy_support_search");
    expect(await tables()).toContain("pithy_support_messages");
  });

  test("both lifecycle statements are idempotent, so a re-provision is safe", async () => {
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);

    await createSearchIndex(db);
    await expect(createSearchIndex(db)).resolves.toBeUndefined();
    await dropSearchIndex(db);
    await expect(dropSearchIndex(db)).resolves.toBeUndefined();
  });

  test("dropping the index leaves the messages behind, because the index is derived", async () => {
    // The property that makes this a provisioned resource rather than a migration: nothing unique
    // lives in it, so losing it costs a rebuild rather than a restore.
    await runMigrations(env.DB, provider(ALL));
    const db = supportDatabase(env.DB);
    await createSearchIndex(db);
    await insertMessage({ id: "m1", threadId: "t1", subject: "Refund", body: "charged twice" });
    await indexMessage(db, { threadId: "t1", messageId: "m1", subject: "Refund", body: "charged twice" });

    await dropSearchIndex(db);
    await createSearchIndex(db);
    expect(await search("charged")).toEqual([]);

    // …and rebuilt from the messages that were never touched.
    expect(await reindexThread(db, "t1")).toBe(1);
    expect(await search("charged")).toEqual(["t1"]);
  });

  test("the full set rolls back to nothing", async () => {
    await runMigrations(env.DB, provider(ALL));
    await rollbackMigration(env.DB, provider(ALL));
    await rollbackMigration(env.DB, provider(ALL));
    expect(await tables()).toEqual([]);
    expect(await triggers()).toEqual([]);
  });
});
