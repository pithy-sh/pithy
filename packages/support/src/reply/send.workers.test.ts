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
type EnqueueInput = Parameters<NonNullable<ReplyDeps["enqueue"]>>[0];

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
        // An outbound mail row carries the job it was enqueued as, and the schema refuses one that
        // does not — the row is only written once the send was accepted.
        emailJobId: seed.direction === "outbound" ? "job-seed" : null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

/** The reply harness: real tables, a recording `enqueue`, and a recording audit sink. */
function harness(
  options: {
    enqueue?: ReplyDeps["enqueue"];
    config?: SupportConfigInput;
    /** Leave `enqueue` off entirely — a project that composed support and not email. */
    noEmailCapability?: boolean;
  } = {},
): {
  deps: ReplyDeps;
  sent: EnqueueInput[];
  events: AuditEventInput[];
} {
  const sent: EnqueueInput[] = [];
  const events: AuditEventInput[] = [];
  let counter = 0;
  const recording: NonNullable<ReplyDeps["enqueue"]> = async (input) => {
    sent.push(input);
    return { jobId: "job-1" };
  };
  return {
    sent,
    events,
    deps: {
      db,
      config: SupportConfig.parse(options.config ?? { inboundAddresses: [INBOX] }),
      enqueue: options.noEmailCapability ? undefined : (options.enqueue ?? recording),
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
    expect(result).toEqual({ channel: "email", messageId: "out-1", jobId: "job-1" });
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

  test("a configured reply-to answers a mail-less project's app thread", async () => {
    await seedAppThread(null);
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
    const { deps, sent } = harness({ config: { reply: { replyToAddress: INBOX } } });

    await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });
    expect(sent[0]?.replyTo).toBe(INBOX);
  });

  /**
   * Delivering the answer in the app instead of mailing it.
   *
   * The read-back this rests on is `readOwnThread`, and that it returns outbound rows is asserted in
   * `store/threads.workers.test.ts` rather than assumed here.
   */
  describe("in-app delivery", () => {
    test("with no address anywhere the answer is stored instead of refused", async () => {
      // The deployment the whole change exists for: a project collecting in-app feedback that never
      // turned on Email Routing, because doing so takes over the zone's MX. There is nobody to mail
      // and somebody who can still read the answer.
      await seedAppThread(null);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
      const { deps, sent } = harness({ config: {} });

      const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

      expect(result).toEqual({ channel: "app", messageId: "out-1" });
      expect(sent).toEqual([]);
      const rows = await outbound();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textBody).toBe(BODY);
    });

    test("with no email capability composed at all the answer is still stored", async () => {
      // `pithy add support` without `pithy add email`. There is no `enqueue` bound to the request, and
      // the reply route used to refuse before anything that knew whether mail was needed had looked.
      await seedAppThread(INBOX);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
      const { deps } = harness({ noEmailCapability: true });

      const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

      expect(result).toEqual({ channel: "app", messageId: "out-1" });
      expect(await outbound()).toHaveLength(1);
    });

    test("an adopter can choose it on a project whose mail works perfectly well", async () => {
      // The reason this is a setting and not a fallback. The dashboard's mail is not impossible, it is
      // merely wrong for this — and a fallback conditioned on impossibility is unreachable by exactly
      // the adopter who wants it most.
      await seedAppThread(INBOX);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "app-1@help.example.com" });
      const { deps, sent } = harness({ config: { inboundAddresses: [INBOX], reply: { deliverInApp: true } } });

      const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

      expect(result).toEqual({ channel: "app", messageId: "out-1" });
      expect(sent).toEqual([]);
    });

    test("the stored answer carries no job id and no envelope", async () => {
      await seedAppThread(INBOX);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
      const { deps } = harness({ config: { inboundAddresses: [INBOX], reply: { deliverInApp: true } } });

      await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

      const rows = await outbound();
      // `channel` is the delivery: `app` says the person reads it in the app, and it is what makes the
      // null job id readable instead of ambiguous.
      expect(rows[0]?.channel).toBe("app");
      expect(rows[0]?.emailJobId).toBeNull();
      // No send happened, so there is no envelope. Writing the deployment's own address here would
      // claim one that did not.
      expect(rows[0]?.fromAddress).toBeNull();
      expect(rows[0]?.toAddress).toBeNull();
    });

    test("the thread counters and the audit event land exactly as they do for mail", async () => {
      await seedAppThread(null);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
      const { deps, events } = harness({ config: {} });

      await sendReply(deps, { threadId: "t1", body: BODY, viewer: "grace@ops" });

      const thread = SupportThread.parse(
        await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", "t1").executeTakeFirstOrThrow(),
      );
      // An answered thread has to move to the top of the inbox whether or not mail was involved.
      expect(thread.messageCount).toBe(2);
      expect(thread.lastMessageAt.getTime()).toBe(NOW);
      // The same action, the same actor, the same resource. Only the send differs — so the trail
      // records the channel, which is the one fact a job id would have carried.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "support/reply_sent",
        outcome: "success",
        actorType: "control-plane",
        actorId: "grace@ops",
        resourceType: "support_thread",
        resourceId: "t1",
        metadata: { channel: "app" },
      });
      expect(events[0]?.metadata).not.toHaveProperty("jobId");
      expect(JSON.stringify(events[0]?.metadata)).not.toContain("Sorry");
    });

    test("an app thread with a deliverable address and no setting still goes out by mail", async () => {
      // The default is unchanged. In-app delivery is opted into or fallen back to, never drifted into.
      await seedAppThread(INBOX);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "app-1@help.example.com" });
      const { deps, sent } = harness();

      const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

      expect(result).toEqual({ channel: "email", messageId: "out-1", jobId: "job-1" });
      expect(sent).toHaveLength(1);
      expect((await outbound())[0]?.channel).toBe("email");
    });

    test("replies switched off still refuse, whatever the delivery would have been", async () => {
      // `reply.enabled: false` is an adopter saying the inbox is read-only. It is not a mail setting,
      // and a second delivery path must not become a way around it.
      await seedAppThread(null);
      await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: null });
      const { deps, events } = harness({ config: { reply: { enabled: false, deliverInApp: true } } });

      await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
        payload: { code: "support/reply_failed" },
      });
      expect(await outbound()).toEqual([]);
      expect(events).toEqual([]);
    });
  });
});

describe("an email thread never takes the in-app path", () => {
  test("with no resolvable reply address it refuses, even with deliverInApp on", async () => {
    // A mail thread's sender has no read-back — there is no session, only an address — so an answer
    // stored for them is one nobody will ever see. A missing reply address here stays the
    // misconfiguration it has always been, and the setting does not reach it.
    await db.updateTable(SUPPORT_THREADS_TABLE).set({ inboxAddress: null }).where("id", "=", "t1").execute();
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, sent, events } = harness({ config: { reply: { deliverInApp: true } } });

    await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/reply_failed" },
    });
    expect(sent).toEqual([]);
    expect(await outbound()).toEqual([]);
    expect(events).toEqual([]);
  });

  test("with no email capability composed it refuses rather than storing an unreadable answer", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps } = harness({ noEmailCapability: true, config: { reply: { deliverInApp: true } } });

    await expect(sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" })).rejects.toMatchObject({
      payload: { code: "support/reply_failed" },
    });
    expect(await outbound()).toEqual([]);
  });

  test("deliverInApp does not divert a mail thread that can be mailed", async () => {
    await seedMessage({ id: "in-1", direction: "inbound", receivedAt: T0, mimeMessageId: "first@mail.example.com" });
    const { deps, sent } = harness({ config: { inboundAddresses: [INBOX], reply: { deliverInApp: true } } });

    const result = await sendReply(deps, { threadId: "t1", body: BODY, viewer: "ada@ops" });

    expect(result).toEqual({ channel: "email", messageId: "out-1", jobId: "job-1" });
    expect(sent).toHaveLength(1);
  });
});
