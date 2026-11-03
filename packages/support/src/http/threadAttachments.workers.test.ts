// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { supportDatabase } from "../data/tables";
import { SUPPORT_MIGRATIONS } from "../migrations/set";
import { resolveReplies } from "../reply/snippets";
import { type HandlerDeps, readConversation } from "./handlers";
import { SupportAttachmentView, SupportThreadResponse } from "./responses";

/**
 * The admin thread view's attachments stay one flat list, and each entry names the message it arrived
 * on, so a console can put a file under the message that carried it rather than under the whole
 * conversation. Read through the real handler over a migrated D1, from rows on two messages.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const T = NOW.getTime() - 60_000;
const THREAD_ID = "0195c1f0-0000-7000-8000-0000000000a1";

const deps: HandlerDeps = {
  db: supportDatabase(env.DB),
  d1: env.DB,
  config: SupportConfig.parse({}),
  categories: resolveCategories({}),
  snippets: resolveReplies({}),
  fts: false,
  semantic: {},
  peers: {},
  dispatchClassify: async () => false,
  emit: async () => {},
  log: noopLogger,
  newId: () => crypto.randomUUID(),
  now: () => NOW,
};

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
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
  await runMigrations(env.DB, provider());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pithy_support_threads (id, inbox_address, subject, from_address, message_count, first_message_at, last_message_at, created_at, updated_at) VALUES (?, 'support@help.example.com', 'Receipts', 'ada@example.com', 2, ?, ?, ?, ?)",
    ).bind(THREAD_ID, T, T + 1, T, T),
    ...["m-first", "m-second"].map((id, n) =>
      env.DB.prepare(
        "INSERT INTO pithy_support_messages (id, thread_id, direction, channel, from_address, subject, text_body, raw_key, received_at, created_at) VALUES (?, ?, 'inbound', 'email', 'ada@example.com', 'Receipts', 'Hello.', ?, ?, ?)",
      ).bind(id, THREAD_ID, `raw/${id}`, T + n, T + n),
    ),
    ...[
      ["a-1", "m-first", "receipt.pdf"],
      ["a-2", "m-second", "invoice.pdf"],
      ["a-3", "m-second", "photo.png"],
    ].map(([id, messageId, filename]) =>
      env.DB.prepare(
        "INSERT INTO pithy_support_attachments (id, message_id, thread_id, filename, content_type, size, sha256, storage_key, created_at) VALUES (?, ?, ?, ?, 'application/pdf', 3, 'abc', ?, ?)",
      ).bind(id, messageId, THREAD_ID, filename, `support/${THREAD_ID}/${id}`, T),
    ),
  ]);
});

describe("GET {base}/threads/:id — attachments name their message", () => {
  test("a thread with attachments on two messages returns each with its own message's id", async () => {
    const response = SupportThreadResponse.parse(await readConversation(deps, THREAD_ID));
    const byId = Object.fromEntries(response.attachments.map((attachment) => [attachment.id, attachment.messageId]));
    expect(byId).toEqual({ "a-1": "m-first", "a-2": "m-second", "a-3": "m-second" });
    // Every id it names is a message of this thread.
    const messageIds = new Set(response.messages.map((message) => message.id));
    for (const attachment of response.attachments) expect(messageIds.has(attachment.messageId ?? "")).toBe(true);
  });

  test("every existing field keeps its place, and messageId comes after them", () => {
    expect(Object.keys(SupportAttachmentView.shape)).toEqual([
      "id",
      "filename",
      "contentType",
      "size",
      "sha256",
      "inline",
      "url",
      "messageId",
    ]);
  });
});
