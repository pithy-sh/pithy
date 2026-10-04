// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareD1Manager } from "@pithy-sh/cloudflare/src/d1/d1Manager";
import { CloudflareD1Provisioner } from "@pithy-sh/cloudflare/src/d1/d1Provisioner";
import { loadIntegrationCreds, uniqueName, withThrowawayResource } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { SUPPORT_MIGRATION_ORDER } from "@pithy-sh/support/src/capability";
import { supportDatabase } from "@pithy-sh/support/src/data/tables";
import { support_0001_threads } from "@pithy-sh/support/src/migrations/0001_threads";
import {
  createSearchIndex,
  dropSearchIndex,
  SEARCH_OBJECTS,
  SEARCH_TRIGGERS,
  searchIndexState,
  searchTriggerStatements,
} from "@pithy-sh/support/src/store/searchIndex";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";

/**
 * LIVE integration test — the support FTS triggers against **remote D1**, not Miniflare.
 *
 * This file is the acceptance criterion the original decision could not meet. The index was written from
 * application code because `CREATE TRIGGER` sat in an undocumented middle on D1: the platform runs an
 * authorizer that rejects SQLite constructs workerd permits — `fts5vocab` is refused where plain FTS5
 * succeeds — so a trigger passing under Miniflare proved **nothing** about the deployment that matters. A
 * Miniflare-only pass is exactly what made that unfalsifiable, so the claim is settled here, on a real
 * database, or not at all.
 *
 * Three things only remote D1 can answer:
 *
 * 1. **The authorizer permits `CREATE TRIGGER` on a real database**, with a compound body that writes to
 *    an FTS5 virtual table.
 * 2. **The casing is load-bearing.** A lowercase `begin`/`end` body is rejected as `incomplete input
 *    [code: 7500]` here and accepted by Miniflare, which is why `searchIndex.test.ts` holds the uppercase
 *    form as a unit test. This proves that unit test is guarding a real constraint rather than a style.
 * 3. **The triggers actually index, through the real column names.** `CamelCasePlugin` does not reach
 *    inside a `sql` template, so the body spells `thread_id` and `text_body` itself, and a write through
 *    the Kysely builder is the only thing that proves the two halves agree.
 *
 * It creates one throwaway D1 under the `pithy-int-` reservation, migrates support's own schema over the
 * REST API, and deletes the database in a `finally`. Run it with `bun run --filter @pithy-sh/cli
 * test:integration`; it skips when `.dev.vars` holds no credentials.
 */
const creds = loadIntegrationCreds();

/** Support's own migration set, as `pithy migrate` composes it. */
const provider: MigrationProvider = (() => {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "support",
      order: SUPPORT_MIGRATION_ORDER,
      migrations: { "0001_threads": support_0001_threads },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
})();

describe.skipIf(!creds.hasCreds)("the support FTS triggers — LIVE remote D1", () => {
  const provisioner = new CloudflareD1Provisioner({ accountId: creds.accountId, apiToken: creds.apiToken });

  test("D1 accepts the triggers, rejects a lowercased body, and indexes every write kind", async () => {
    await withThrowawayResource(
      () => provisioner.createDatabase(uniqueName("support-fts")),
      async (created) => {
        const manager = new CloudflareD1Manager({
          accountId: creds.accountId,
          apiToken: creds.apiToken,
          databaseId: created.uuid,
        });
        const d1 = manager as unknown as D1Database;

        // Support's real schema, over the real REST path — so every column the trigger bodies name is
        // the column `pithy migrate` actually creates.
        await runMigrations(d1, provider);
        expect(await manager.listTables()).toContain("pithy_support_messages");

        // **1. The casing, proved as a refusal first.** Asserted before the index exists, so the failure
        // can only be the parser: a lowercase compound body is incomplete input to D1 and fine to
        // Miniflare, which is the whole reason `searchIndex.test.ts` pins the uppercase form.
        const lowercased = searchTriggerStatements()[0]
          ?.replace(/\bBEGIN\b/, "begin")
          .replace(/\bEND\b/, "end");
        await expect(manager.executeQuery(lowercased ?? "")).rejects.toThrow(/incomplete input|7500/i);

        // **2. The authorizer permits the real statements.** `createSearchIndex` issues the virtual table
        // and all three `CREATE TRIGGER`s; a refusal here is what the whole workaround existed for.
        const db = supportDatabase(d1);
        await createSearchIndex(db);
        const present = await manager.executeQuery(
          `SELECT name FROM sqlite_master WHERE name IN (${SEARCH_OBJECTS.map(() => "?").join(", ")})`,
          [...SEARCH_OBJECTS],
        );
        const names = ((present[0]?.results ?? []) as { name: string }[]).map((row) => row.name);
        expect(searchIndexState(names)).toEqual({ table: true, triggers: "all" });
        expect(names).toEqual(expect.arrayContaining([...SEARCH_TRIGGERS]));

        // **3. The index follows the table, through the physical column names.** Written with raw SQL on
        // purpose here: the Kysely-builder write is proved in `@pithy-sh/support`'s own suite, and what is
        // under test on this database is the trigger, not the dialect.
        const insert = `INSERT INTO pithy_support_messages
            (id, thread_id, direction, from_address, to_address, subject, text_body, received_at, created_at)
          VALUES (?, ?, 'inbound', 'ada@example.com', 'support@help.example.com', ?, ?, 1, 1)`;
        await manager.executeQuery(insert, ["m1", "t1", "Refund please", "I was charged twice"]);
        const search = async (term: string): Promise<string[]> => {
          const rows = await manager.executeQuery(
            "SELECT DISTINCT thread_id FROM pithy_support_search WHERE pithy_support_search MATCH ?",
            [term],
          );
          return ((rows[0]?.results ?? []) as { thread_id: string }[]).map((row) => row.thread_id);
        };
        expect(await search("charged")).toEqual(["t1"]);
        expect(await search("refund")).toEqual(["t1"]);

        // An update re-indexes, and replaces rather than appends.
        await manager.executeQuery("UPDATE pithy_support_messages SET text_body = ? WHERE id = ?", [
          "resolved happily",
          "m1",
        ]);
        expect(await search("charged")).toEqual([]);
        expect(await search("resolved")).toEqual(["t1"]);
        const counted = await manager.executeQuery(
          "SELECT COUNT(*) AS n FROM pithy_support_search WHERE message_id = 'm1'",
        );
        expect(((counted[0]?.results ?? []) as { n: number }[])[0]?.n).toBe(1);

        // A delete takes the index row with it.
        await manager.executeQuery("DELETE FROM pithy_support_messages WHERE id = ?", ["m1"]);
        expect(await search("resolved")).toEqual([]);

        // **4. The inverted durability contract, on the database it matters on.** With the FTS table gone
        // and the triggers still there, the message write fails rather than silently skipping the index.
        await manager.executeQuery("DROP TABLE pithy_support_search");
        await expect(manager.executeQuery(insert, ["m2", "t2", "Hello", "nothing to index"])).rejects.toThrow(
          /pithy_support_search/,
        );

        // **5. And the pair cannot be left half-dropped.** `dropSearchIndex` clears the stray triggers, so
        // `search.fts: false` is a feature flag rather than an outage on the capability's write path.
        await createSearchIndex(db);
        await dropSearchIndex(db);
        const after = await manager.executeQuery(
          `SELECT name FROM sqlite_master WHERE name IN (${SEARCH_OBJECTS.map(() => "?").join(", ")})`,
          [...SEARCH_OBJECTS],
        );
        expect((after[0]?.results ?? []).length).toBe(0);
        await manager.executeQuery(insert, ["m3", "t3", "Hello", "nothing to index"]);
        expect(await manager.listTables()).toContain("pithy_support_messages");
      },
      (created) => provisioner.deleteDatabase(created.uuid),
    );
  });
});
