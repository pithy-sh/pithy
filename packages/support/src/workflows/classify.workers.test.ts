// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import type { SupportAi } from "../ai/classify";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportAiConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { SupportClassification } from "../data/classification";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_CLASSIFICATIONS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { support_0001_threads } from "../migrations/0001_threads";
import { type ClassifyDeps, latestInboundMessageId, runClassification } from "./classify";

/**
 * Classification against real D1, with the `AI` binding injected as a fake.
 *
 * The model is faked because the two writes are what matter: an append-only history row and a
 * denormalized answer on the thread. Those are the asymmetry the whole design rests on, and only a
 * live database can show them diverging.
 */

const T0 = 1_700_000_000_000;
const INBOX = "support@help.example.com";

const db = supportDatabase(env.DB);

/** Build an app-database provider for the tables migration. */
function provider(): MigrationProvider {
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
}

/** A model that always answers the same way. */
function fakeAi(answer: Record<string, unknown>): SupportAi {
  return { run: async () => ({ response: JSON.stringify(answer) }) };
}

/** A model that must never be reached. */
const forbiddenAi: SupportAi = {
  run: async () => {
    throw new Error("the model was asked about a message that does not exist");
  },
};

/** The classification harness, with the model and the clock injectable. */
function deps(options: {
  ai: SupportAi;
  model?: string;
  now?: number;
  idPrefix?: string;
  archiveSpam?: boolean;
}): ClassifyDeps {
  let counter = 0;
  return {
    db,
    ai: options.ai,
    categories: resolveCategories(),
    ai_config: SupportAiConfig.parse({ model: options.model ?? "@cf/test/classifier-v1" }),
    archiveSpam: options.archiveSpam ?? true,
    newId: () => `${options.idPrefix ?? "c"}-${++counter}`,
    now: () => new Date(options.now ?? T0 + 1_000),
  };
}

/** Insert the thread every test classifies against. */
async function seedThread(seed: { declaredCategory?: string } = {}): Promise<void> {
  const at = new Date(T0);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id: "t1",
        channel: "email",
        inboxAddress: INBOX,
        subject: "Charged twice",
        fromAddress: "ada@example.com",
        fromName: null,
        senderAuthenticated: true,
        userId: null,
        declaredCategory: seed.declaredCategory ?? null,
        category: "uncategorized",
        priority: "normal",
        sentiment: "neutral",
        confidence: null,
        model: null,
        classifiedAt: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 1,
        firstMessageAt: at,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

/** Insert one message on the thread. */
async function seedMessage(seed: {
  id: string;
  direction?: "inbound" | "outbound";
  receivedAt?: number;
}): Promise<void> {
  const at = new Date(seed.receivedAt ?? T0);
  await db
    .insertInto(SUPPORT_MESSAGES_TABLE)
    .values(
      SupportMessage.encode({
        id: seed.id,
        threadId: "t1",
        direction: seed.direction ?? "inbound",
        channel: "email" as const,
        submittedByUserId: null,
        context: null,
        mimeMessageId: `${seed.id}@mail.example.com`,
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: "ada@example.com",
        fromName: null,
        toAddress: INBOX,
        subject: "Charged twice",
        textBody: "I was charged twice and I want it back",
        htmlBody: null,
        // An outbound mail row carries the job it was enqueued as, and the schema refuses one that
        // does not — the row is only written once the send was accepted.
        emailJobId: (seed.direction ?? "inbound") === "outbound" ? "job-seed" : null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

/** The thread row, decoded. */
async function thread(): Promise<SupportThread> {
  return SupportThread.parse(
    await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", "t1").executeTakeFirstOrThrow(),
  );
}

/** The classification history, oldest first. */
async function history(): Promise<SupportClassification[]> {
  const rows = await db
    .selectFrom(SUPPORT_CLASSIFICATIONS_TABLE)
    .selectAll()
    .where("threadId", "=", "t1")
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((row) => SupportClassification.parse(row));
}

beforeEach(async () => {
  for (const table of [
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
  await seedThread();
});

describe("runClassification", () => {
  test("appends a classification row and denormalizes the answer onto the thread", async () => {
    await seedMessage({ id: "m1" });
    const ai = fakeAi({ category: "billing", priority: "urgent", sentiment: "angry", confidence: 0.9 });

    const outcome = await runClassification(deps({ ai }), "m1");

    expect(outcome).toEqual({
      threadId: "t1",
      category: "billing",
      confidence: 0.9,
      model: "@cf/test/classifier-v1",
      archivedAsSpam: false,
    });
    expect(await history()).toMatchObject([{ messageId: "m1", category: "billing", model: "@cf/test/classifier-v1" }]);

    // Both writes, not one. The inbox query reads these five columns off the thread — a history row
    // alone would leave the dashboard sorting an inbox that was never classified.
    const row = await thread();
    expect(row.category).toBe("billing");
    expect(row.priority).toBe("urgent");
    expect(row.sentiment).toBe("angry");
    expect(row.confidence).toBe(0.9);
    expect(row.model).toBe("@cf/test/classifier-v1");
    expect(row.classifiedAt?.getTime()).toBe(T0 + 1_000);
  });

  test("a second run appends a second row while the thread carries only the latest", async () => {
    await seedMessage({ id: "m1" });
    const first = fakeAi({ category: "billing", priority: "urgent", sentiment: "angry", confidence: 0.5 });
    const second = fakeAi({ category: "bug_report", priority: "normal", sentiment: "neutral", confidence: 0.95 });

    await runClassification(deps({ ai: first, model: "@cf/test/classifier-v1", now: T0 + 1_000 }), "m1");
    await runClassification(
      deps({ ai: second, model: "@cf/test/classifier-v2", now: T0 + 2_000, idPrefix: "c2" }),
      "m1",
    );

    // Append-only is what makes a backfill after a model upgrade legible: the history says which
    // model produced which judgment and what changed, so "what did v2 disagree with v1 about" is a
    // query. Updating in place would make the upgrade a silent rewrite of the record.
    expect((await history()).map((row) => [row.model, row.category])).toEqual([
      ["@cf/test/classifier-v1", "billing"],
      ["@cf/test/classifier-v2", "bug_report"],
    ]);

    const row = await thread();
    expect(row.category).toBe("bug_report");
    expect(row.model).toBe("@cf/test/classifier-v2");
  });

  test("the classifier never touches what the submitter said, however often it runs", async () => {
    // **The reason these are two columns rather than one with a precedence rule.** A classification is
    // idempotent by construction — a Workflow retry, a manual reclassify and a post-upgrade backfill
    // are the same operation, and each one overwrites `category` unconditionally. A submitter's claim
    // sharing that column would be gone on the first of them, and a `categorySource` beside a single
    // column loses whichever of the two facts it does not currently name. What an operator needs is
    // precisely the pair: they said billing, the model says bug_report.
    await db.updateTable(SUPPORT_THREADS_TABLE).set({ declaredCategory: "billing" }).where("id", "=", "t1").execute();
    await seedMessage({ id: "m1" });

    await runClassification(
      deps({ ai: fakeAi({ category: "bug_report", priority: "normal", sentiment: "neutral", confidence: 0.9 }) }),
      "m1",
    );
    await runClassification(
      deps({
        ai: fakeAi({ category: "feature_request", priority: "low", sentiment: "positive", confidence: 0.4 }),
        now: T0 + 2_000,
        idPrefix: "c2",
      }),
      "m1",
    );

    const row = await thread();
    expect(row.category).toBe("feature_request");
    expect(row.declaredCategory).toBe("billing");
  });

  test("a message that is gone returns null, and the model is never asked", async () => {
    // A Workflow instance can outlive the row that started it — a retry after a rollback is the
    // ordinary way that happens, and it is not a failure worth burning a retry budget on.
    expect(await runClassification(deps({ ai: forbiddenAi }), "vanished")).toBeNull();
    expect(await history()).toEqual([]);
  });

  test("a model answer outside the taxonomy lands as uncategorized rather than in the thread", async () => {
    await seedMessage({ id: "m1" });
    const ai = fakeAi({ category: "refund_dispute", priority: "urgent", sentiment: "angry", confidence: 0.99 });

    await runClassification(deps({ ai }), "m1");

    // An invented label would otherwise poison every filter downstream, and its confidence is not
    // confidence in the answer that was stored.
    expect((await thread()).category).toBe("uncategorized");
    expect((await thread()).confidence).toBe(0);
  });

  test("spam is archived by the same write that classifies it, and names the model as the actor", async () => {
    await seedMessage({ id: "m1" });
    const ai = fakeAi({ category: "spam", priority: "low", sentiment: "neutral", confidence: 0.8 });

    const outcome = await runClassification(deps({ ai }), "m1");

    // One write, not a second pass — anything else leaves a window where spam sits in an open inbox.
    // Archived rather than deleted, so a misclassification is one click from being back.
    expect(outcome?.archivedAsSpam).toBe(true);
    const row = await thread();
    expect(row.archived).toBe(true);
    expect(row.archivedBy).toBe("@cf/test/classifier-v1");
  });

  test("spam stays in the open inbox when archiveSpam is off", async () => {
    await seedMessage({ id: "m1" });
    const ai = fakeAi({ category: "spam", priority: "low", sentiment: "neutral", confidence: 0.8 });

    const outcome = await runClassification(deps({ ai, archiveSpam: false }), "m1");

    expect(outcome?.archivedAsSpam).toBe(false);
    expect((await thread()).archived).toBe(false);
  });
});

describe("latestInboundMessageId", () => {
  test("picks the newest inbound message and ignores our own replies", async () => {
    await seedMessage({ id: "in-old", direction: "inbound", receivedAt: T0 });
    await seedMessage({ id: "in-new", direction: "inbound", receivedAt: T0 + 100 });
    await seedMessage({ id: "out", direction: "outbound", receivedAt: T0 + 200 });

    // A reclassify that ran on the newest message overall would judge the thread by the text the
    // adopter wrote, which says nothing about what the customer wanted.
    expect(await latestInboundMessageId(db, "t1")).toBe("in-new");
  });

  test("returns undefined for a thread with nothing inbound on it", async () => {
    await seedMessage({ id: "out", direction: "outbound", receivedAt: T0 });
    expect(await latestInboundMessageId(db, "t1")).toBeUndefined();
  });
});
