// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import type { SupportChannel, SupportPriority, SupportSentiment } from "../data/enums";
import { UNCATEGORIZED } from "../data/enums";
import { SupportMessage } from "../data/message";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, type SupportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { SUPPORT_MIGRATIONS } from "../migrations/set";

/** Rows for Workers tests: a clean support schema, a thread, and a message, each with sensible defaults. */

export const SEED_INBOX = "support@help.example.com";

/** Every table a support test may have left behind, children first. */
const TABLES = [
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
];

/** Drop everything and run the whole chain, so each test starts from today's schema. */
export async function freshSupportSchema(d1: D1Database): Promise<void> {
  await d1.exec("DROP TRIGGER IF EXISTS pithy_support_search_ai");
  await d1.exec("DROP TRIGGER IF EXISTS pithy_support_search_au");
  await d1.exec("DROP TRIGGER IF EXISTS pithy_support_search_ad");
  for (const table of TABLES) await d1.exec(`DROP TABLE IF EXISTS ${table}`);
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  if (!registry.app) throw new Error('expected a provider for database "app"');
  await runMigrations(d1, registry.app);
}

/** Insert one thread. */
export async function seedThread(
  db: SupportDatabase,
  seed: {
    id: string;
    lastMessageAt: number;
    category?: string;
    declaredCategory?: string;
    priority?: SupportPriority;
    sentiment?: SupportSentiment;
    channel?: SupportChannel;
    inbox?: string;
    archived?: boolean;
    assigneeRef?: string;
    subject?: string;
  },
): Promise<void> {
  const at = new Date(seed.lastMessageAt);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id: seed.id,
        channel: seed.channel ?? "email",
        inboxAddress: seed.inbox ?? SEED_INBOX,
        subject: seed.subject ?? `Thread ${seed.id}`,
        fromAddress: "ada@example.com",
        fromName: null,
        senderAuthenticated: true,
        userId: null,
        declaredCategory: seed.declaredCategory ?? null,
        category: seed.category ?? UNCATEGORIZED,
        priority: seed.priority ?? "normal",
        sentiment: seed.sentiment ?? "neutral",
        confidence: null,
        model: null,
        classifiedAt: null,
        archived: seed.archived ?? false,
        archivedAt: null,
        archivedBy: null,
        assigneeRef: seed.assigneeRef ?? null,
        assigneeName: seed.assigneeRef ? `Name ${seed.assigneeRef}` : null,
        assignedAt: seed.assigneeRef ? at : null,
        assignedBy: seed.assigneeRef ? "cp-1" : null,
        messageCount: 1,
        firstMessageAt: at,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

/** Insert one message. */
export async function seedMessage(
  db: SupportDatabase,
  seed: {
    id: string;
    threadId: string;
    subject: string;
    body: string;
    receivedAt?: number;
    direction?: "inbound" | "outbound";
  },
): Promise<void> {
  const at = new Date(seed.receivedAt ?? 1_700_000_000_000);
  await db
    .insertInto(SUPPORT_MESSAGES_TABLE)
    .values(
      SupportMessage.encode({
        id: seed.id,
        threadId: seed.threadId,
        direction: seed.direction ?? "inbound",
        channel: "email" as const,
        submittedByUserId: null,
        context: null,
        mimeMessageId: `${seed.id}@mail.example.com`,
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: "ada@example.com",
        fromName: null,
        toAddress: SEED_INBOX,
        subject: seed.subject,
        textBody: seed.body,
        htmlBody: null,
        // An outbound mail row names the job it was enqueued as; the schema refuses one that does not.
        emailJobId: seed.direction === "outbound" ? `job-${seed.id}` : null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}
