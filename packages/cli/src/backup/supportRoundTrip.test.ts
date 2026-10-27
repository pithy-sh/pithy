// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { support } from "@pithy-sh/support/src/capability";
import { UNCATEGORIZED } from "@pithy-sh/support/src/data/enums";
import { SupportMessage } from "@pithy-sh/support/src/data/message";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "@pithy-sh/support/src/data/tables";
import { SupportThread } from "@pithy-sh/support/src/data/thread";
import { provisionSearchIndex } from "@pithy-sh/support/src/store/provisionIndex";
import { SEARCH_TABLE, SEARCH_TRIGGERS } from "@pithy-sh/support/src/store/searchIndex";
import { listThreads } from "@pithy-sh/support/src/store/threads";
import { describe, expect, test, vi } from "vitest";
import { migrateProject } from "../migrations/run";
import { migrateHarness, withLocalD1 } from "../test-utils/migrateHarness";
import { runBackup } from "./backup";
import { BackupManifest } from "./files";
import { runRestore, type SearchIndexRebuild } from "./restore";

/**
 * Support's real FTS5 index through a backup and a restore (#848). The backup leaves the virtual table,
 * its shadow tables and its three triggers out; the restore rebuilds them through `provisionSearchIndex`,
 * the code `pithy support provision` runs, and search answers what it answered before.
 */

const AT = new Date(1_700_000_000_000);
const NOW = new Date(1_800_000_000_000);

/** The CLI's default loads `@pithy-sh/support` from the project's install; the fixture has none, so it is handed over. */
const rebuild: SearchIndexRebuild = async (_projectDir, d1, wanted) => ({
  table: SEARCH_TABLE,
  action: await provisionSearchIndex(d1, wanted),
});

async function seed(d1: D1Database): Promise<void> {
  const db = supportDatabase(d1);
  for (const [id, body] of [
    ["refund", "I was charged twice"],
    ["login", "the link never arrived"],
  ] as const) {
    await db
      .insertInto(SUPPORT_THREADS_TABLE)
      .values(
        SupportThread.encode({
          id,
          channel: "email",
          inboxAddress: "support@help.example.com",
          subject: id,
          fromAddress: "ada@example.com",
          fromName: null,
          senderAuthenticated: true,
          userId: null,
          declaredCategory: null,
          category: UNCATEGORIZED,
          priority: "normal",
          sentiment: "neutral",
          confidence: null,
          model: null,
          classifiedAt: null,
          archived: false,
          archivedAt: null,
          archivedBy: null,
          messageCount: 1,
          firstMessageAt: AT,
          lastMessageAt: AT,
          createdAt: AT,
          updatedAt: AT,
        }),
      )
      .execute();
    await db
      .insertInto(SUPPORT_MESSAGES_TABLE)
      .values(
        SupportMessage.encode({
          id: `m-${id}`,
          threadId: id,
          direction: "inbound",
          channel: "email",
          submittedByUserId: null,
          context: null,
          mimeMessageId: `${id}@mail.example.com`,
          mimeInReplyTo: null,
          mimeReferences: null,
          fromAddress: "ada@example.com",
          fromName: null,
          toAddress: "support@help.example.com",
          subject: id,
          textBody: body,
          htmlBody: null,
          emailJobId: null,
          rawKey: null,
          rawBytes: null,
          receivedAt: AT,
          createdAt: AT,
        }),
      )
      .execute();
  }
}

const search = async (d1: D1Database, q: string): Promise<string[]> =>
  (await listThreads(supportDatabase(d1), { q }, { fts: true, viewer: "v", now: NOW })).threads.map((one) => one.id);

describe("support's index through backup and restore", () => {
  const h = migrateHarness();

  test("is left out of the backup and rebuilt by the restore, and search answers as it did", async () => {
    const workers = [h.api([support()])];
    await migrateProject({ projectDir: h.projectDir, project: "acme", account: null, env: "dev", workers });
    await withLocalD1(h.projectDir, "DB", async (d1) => {
      await seed(d1);
      expect(await provisionSearchIndex(d1, true)).toBe("create");
      expect(await search(d1, "charged")).toEqual(["refund"]);
    });

    const output = join(h.projectDir, "out");
    const [report] = await runBackup({
      projectDir: h.projectDir,
      project: "acme",
      account: null,
      env: "dev",
      workers,
      output,
      kitVersion: "1.0.0",
    });
    expect(report?.virtualTables).toEqual([SEARCH_TABLE]);
    const manifest = BackupManifest.parse(JSON.parse(await readFile(join(output, "DB", "manifest.json"), "utf8")));
    // Every shadow table SQLite reports, and nothing under the prefix that is a real table.
    expect(
      manifest.leftOut
        .filter((entry) => entry.reason === "shadow")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([
      "pithy_support_search_config",
      "pithy_support_search_content",
      "pithy_support_search_data",
      "pithy_support_search_docsize",
      "pithy_support_search_idx",
    ]);
    expect(manifest.skippedTriggers.map((entry) => entry.name).sort()).toEqual([...SEARCH_TRIGGERS].sort());
    expect(manifest.tables.map((table) => table.name)).toContain("pithy_support_messages");
    expect(await readFile(join(output, "DB", "data.sql"), "utf8")).not.toMatch(/pithy_support_search/);
    expect(report?.restorable).toBe(true);

    const audit = vi.fn(async () => {});
    const [restored] = await runRestore({
      projectDir: h.projectDir,
      project: "acme",
      account: null,
      env: "dev",
      workers,
      input: output,
      kitVersion: "1.0.0",
      recovery: async () => "recovery",
      searchIndex: rebuild,
      audit,
    });
    expect(restored?.rebuilt).toEqual([{ name: SEARCH_TABLE, how: "provisioned" }]);
    // The rebuild is the one `pithy support provision` audits, so it records the same event here.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support/search_index_created",
        outcome: "success",
        resourceType: "d1_table",
        resourceId: SEARCH_TABLE,
      }),
    );
    await withLocalD1(h.projectDir, "recovery", async (d1) => {
      expect(await search(d1, "charged")).toEqual(["refund"]);
      expect(await search(d1, "arrived")).toEqual(["login"]);
      const triggers = await d1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all<{ name: string }>();
      expect(triggers.results.map((row) => row.name)).toEqual([
        "pithy_support_search_ad",
        "pithy_support_search_ai",
        "pithy_support_search_au",
      ]);
    });
  });
});
