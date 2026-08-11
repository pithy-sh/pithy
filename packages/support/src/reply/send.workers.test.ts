// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig, type SupportConfigInput } from "../config/config";
import { SupportMessage } from "../data/message";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { support_0001_threads } from "../migrations/0001_threads";
import { type ReplyDeps, sendReply } from "./send";

/**
 * The reply path against real D1, with the email capability's `enqueue` injected as a fake.
 *
 * What is worth asserting here is what leaves the building: the headers that keep the customer's mail
 * client showing one conversation, the row that must not exist unless the send was accepted, and the
 * audit event that records who wrote under the adopter's domain.
 */

const T0 = 1_700_000_000_000;
const NOW = T0 + 10_000;
const INBOX = "support@help.example.com";
const CUSTOMER = "ada@example.com";
const BODY = "Refunded. Sorry about the double charge.";

const db = supportDatabase(env.DB);

/** What the fake `enqueue` was handed. */
type EnqueueInput = Parameters<ReplyDeps["enqueue"]>[0];

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

/** Insert the thread every test replies to. */
async function seedThread(subject = "Double charge"): Promise<void> {
  const at = new Date(T0);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id: "t1",
        channel: "email",
        inboxAddress: INBOX,
        subject,
        fromAddress: CUSTOMER,
        fromName: "Ada",
        senderAuthenticated: true,
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
  direction: "inbound" | "outbound";
  receivedAt: number;
  mimeMessageId?: string | null;
  mimeReferences?: string[] | null;
}): Promise<void> {
  const at = new Date(seed.receivedAt);
  await db
    .insertInto(SUPPORT_MESSAGES_TABLE)
    .values(
      SupportMessage.encode({
        id: seed.id,
        threadId: "t1",
        direction: seed.direction,
        channel: "email" as const,
        submittedByUserId: null,
        context: null,
        mimeMessageId: seed.mimeMessageId ?? null,
        mimeInReplyTo: null,
        mimeReferences: seed.mimeReferences ?? null,
        fromAddress: seed.direction === "inbound" ? CUSTOMER : INBOX,
        fromName: null,
        toAddress: seed.direction === "inbound" ? INBOX : CUSTOMER,
        subject: "Double charge",
        textBody: "I was charged twice",
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

/** The reply harness: real tables, a recording `enqueue`, and a recording audit sink. */
function harness(options: { enqueue?: ReplyDeps["enqueue"]; config?: SupportConfigInput } = {}): {
  deps: ReplyDeps;
  sent: EnqueueInput[];
  events: AuditEventInput[];
} {
  const sent: EnqueueInput[] = [];
  const events: AuditEventInput[] = [];
  let counter = 0;
  return {
    sent,
    events,
    deps: {
      db,
      config: SupportConfig.parse(options.config ?? { inboundAddresses: [INBOX] }),
      enqueue:
        options.enqueue ??
        (async (input) => {
          sent.push(input);
          return { jobId: "job-1" };
        }),
      fts: false,
      emit: async (event) => {
        events.push(event);
      },
      log: noopLogger,
      newId: () => `out-${++counter}`,
      now: () => new Date(NOW),
    },
  };
}

/** The outbound rows on the thread. */
async function outbound() {
  return db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .selectAll()
    .where("threadId", "=", "t1")
    .where("direction", "=", "outbound")
    .execute();
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

describe("sendReply", () => {
  test("enqueues the support template to the customer, under a Re: subject", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, sent } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe("supportReply");
    expect(sent[0]?.to).toBe(CUSTOMER);
    expect(sent[0]?.payload).toMatchObject({ subject: "Re: Double charge", body: BODY });
    // The answer has to come back to an address this inbox claims, or the conversation ends here.
    expect(sent[0]?.replyTo).toBe(INBOX);
  });

  test("In-Reply-To is the parent's Message-ID in brackets, and References is the chain plus the parent", async () => {
    await seedMessage({
      id: "in-1",
      direction: "inbound",
      receivedAt: T0,
      mimeMessageId: "third@mail.example.com",
      mimeReferences: ["root@mail.example.com", "second@mail.example.com"],
    });
    const { deps, sent } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    // RFC 5322 §3.6.4, and the assertion the whole reply design exists for. Get either header wrong —
    // drop the brackets, omit the parent's own id, reverse the chain — and the customer's mail client
    // stops threading: every answer becomes a separate message and the conversation fragments.
    expect(sent[0]?.inReplyTo).toBe("<third@mail.example.com>");
    expect(sent[0]?.references).toBe("<root@mail.example.com> <second@mail.example.com> <third@mail.example.com>");
  });

  test("threads against the newest inbound message, never our own last reply", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    await seedMessage({
      id: "in-2",
      direction: "inbound",
      receivedAt: T0 + 200,
      mimeMessageId: "latest@mail.example.com",
    });
    await seedMessage({
      id: "out-old",
      direction: "outbound",
      receivedAt: T0 + 300,
      mimeMessageId: "ours@mail.example.com",
    });
    const { deps, sent } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    // The outbound row is the newest message on the thread, so an unfiltered "latest message" query
    // would pick it — and chain the conversation to an id Cloudflare never gave us.
    expect(sent[0]?.inReplyTo).toBe("<latest@mail.example.com>");
  });

  test("the outbound row carries the job id and no Message-ID", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps } = harness();

    const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    const rows = await outbound();
    expect(rows).toHaveLength(1);
    // Cloudflare assigns the real Message-ID at send time and never tells the enqueuer, so a column
    // claiming to hold it would be null exactly when somebody needed it. The job id is what is real.
    expect(rows[0]?.mimeMessageId).toBeNull();
    expect(rows[0]?.emailJobId).toBe("job-1");
    expect(result.messageId).toBe(rows[0]?.id);
  });

  test("the thread's message count and last-message time move forward", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    const thread = SupportThread.parse(
      await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", "t1").executeTakeFirstOrThrow(),
    );
    expect(thread.messageCount).toBe(2);
    // The inbox sorts on this: a reply that left the thread's position alone would sink an answered
    // conversation below every unanswered one.
    expect(thread.lastMessageAt.getTime()).toBe(NOW);
  });

  test("audits the send against the viewer who wrote it, and never records the body", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, events } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "grace@ops" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "support/reply_sent",
      outcome: "success",
      actorType: "control-plane",
      actorId: "grace@ops",
      resourceType: "support_thread",
      resourceId: "t1",
    });
    // The trail is queryable and long-lived, and a support reply is somebody's private
    // correspondence. Nothing the human typed belongs in it.
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("Sorry");
  });

  test("a deployment with replies switched off refuses rather than sending", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, sent } = harness({ config: { inboundAddresses: [INBOX], reply: { enabled: false } } });

    await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/reply_failed" },
    });
    expect(sent).toEqual([]);
  });

  test("an enqueue that fails leaves no outbound row on the thread", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, events } = harness({
      enqueue: async () => {
        throw new Error("email capability unavailable");
      },
    });

    await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/reply_failed" },
    });
    // The row goes in after the enqueue is accepted, so the thread never shows an operator a reply
    // that was never handed to anything capable of sending it.
    expect(await outbound()).toEqual([]);
    expect(events).toEqual([]);
  });

  test("throws support/not_found for a thread that does not exist", async () => {
    const { deps } = harness();
    await expect(sendReply(deps, { threadId: "ghost", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/not_found" },
    });
  });
});

describe("answering a thread that started in the app", () => {
  /** Replace the seeded thread with one filed through `POST /support/feedback`. */
  async function seedAppThread(inboxAddress: string | null): Promise<void> {
    await db.deleteFrom(SUPPORT_THREADS_TABLE).where("id", "=", "t1").execute();
    const at = new Date(T0);
    await db
      .insertInto(SUPPORT_THREADS_TABLE)
      .values(
        SupportThread.encode({
          id: "t1",
          channel: "app",
          inboxAddress,
          subject: "Export button does nothing",
          // The account's own address, read from the account at submission time — which is what lets a
          // reply leave on the existing mail path with nothing new to configure.
          fromAddress: CUSTOMER,
          fromName: "Ada",
          senderAuthenticated: true,
          userId: "user-ada",
          accountLinkSource: "session",
          category: "bug_report",
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

  test("the reply reaches the submitter by email, on the unchanged reply path", async () => {
    await seedAppThread(INBOX);
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "app-1@help.example.com" });
    const { deps, sent } = harness();

    const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(CUSTOMER);
    // The answer comes back to an address this inbox claims, so the conversation does not end here.
    expect(sent[0]?.replyTo).toBe(INBOX);
    // Threaded against the id minted for the submission — without it her answer opens a second thread
    // and the conversation fragments into one message per reply.
    expect(sent[0]?.inReplyTo).toBe("<app-1@help.example.com>");
    expect(result.jobId).toBe("job-1");
  });

  test("the outbound row is `email`, whatever the thread started as", async () => {
    await seedAppThread(INBOX);
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "app-1@help.example.com" });
    const { deps } = harness();

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });
    const rows = await outbound();
    // Per message rather than only per thread, because this is the case where the two differ.
    expect(rows[0]?.channel).toBe("email");
  });

  test("with no address anywhere the reply is refused rather than sent from a guess", async () => {
    // Only reachable on an app thread: a project collecting in-app feedback with no mail configured.
    // A reply the customer cannot answer looks like the conversation continued, which is worse than a
    // refusal an operator can read.
    await seedAppThread(null);
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
    const { deps, sent } = harness({ config: {} });

    await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/reply_failed" },
    });
    expect(sent).toEqual([]);
    expect(await outbound()).toEqual([]);
  });

  test("a configured reply-to answers a mail-less project's app thread", async () => {
    await seedAppThread(null);
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
    const { deps, sent } = harness({ config: { reply: { replyToAddress: INBOX } } });

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });
    expect(sent[0]?.replyTo).toBe(INBOX);
  });
});
