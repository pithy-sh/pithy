// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportEmbedding } from "../data/embedding";
import { SUPPORT_EMBEDDINGS_TABLE, supportDatabase } from "../data/tables";
import { SUPPORT_MIGRATIONS } from "./set";

/** `0003_embeddings` as `pithy migrate` composes it — the whole chain up, then down one step at a time. */

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function tables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pithy_support_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((row) => row.name);
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_search",
    "pithy_support_embeddings",
    "pithy_support_assignments",
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

describe("support_0003_embeddings", () => {
  test("is in the set, after 0002", () => {
    expect(Object.keys(SUPPORT_MIGRATIONS)).toEqual(["0001_threads", "0002_assignment", "0003_embeddings"]);
  });

  test("up creates the stamp table, and a stamp round-trips through its codec", async () => {
    await runMigrations(env.DB, provider());
    expect(await tables()).toContain("pithy_support_embeddings");
    const db = supportDatabase(env.DB);
    const stamp = { messageId: "m1", model: "@cf/baai/bge-m3", embeddedAt: new Date(1_700_000_000_000) };
    await db.insertInto(SUPPORT_EMBEDDINGS_TABLE).values(SupportEmbedding.encode(stamp)).execute();
    const row = await db.selectFrom(SUPPORT_EMBEDDINGS_TABLE).selectAll().executeTakeFirstOrThrow();
    expect(SupportEmbedding.parse(row)).toEqual(stamp);
  });

  test("one stamp per message — the key is the message id", async () => {
    await runMigrations(env.DB, provider());
    const insert = "INSERT INTO pithy_support_embeddings (message_id, model, embedded_at) VALUES ('m1', 'a', 1)";
    await env.DB.prepare(insert).run();
    await expect(env.DB.prepare(insert).run()).rejects.toThrow();
  });

  test("down drops it and leaves 0002's tables as they were", async () => {
    await runMigrations(env.DB, provider());
    await rollbackMigration(env.DB, provider());
    const after = await tables();
    expect(after).not.toContain("pithy_support_embeddings");
    expect(after).toContain("pithy_support_assignments");
    expect(after).toContain("pithy_support_messages");
  });
});
