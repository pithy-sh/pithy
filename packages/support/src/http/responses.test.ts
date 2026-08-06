// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { SupportMessage } from "../data/message";
import type { SupportThread } from "../data/thread";
import type { SenderContext } from "../link/sender";
import type { ListedThread } from "../store/threads";
import {
  SenderContextView,
  SupportAttachmentView,
  SupportFlagsResponse,
  SupportListedThreadView,
  SupportMessageView,
  SupportRepliesResponse,
  SupportReplySentResponse,
  SupportThreadResponse,
  SupportThreadsResponse,
  SupportThreadView,
} from "./responses";
import { listedThreadView, messageView, senderView, threadView } from "./views";

/**
 * The response schemas against what the projections actually produce.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * projection that has grown a field the schema never heard of — a column added to
 * `pithy_support_threads` and spread into a response, say. Comparing the parsed value with the input
 * fails in both directions, which is what makes the two unable to drift silently.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const AT = new Date("2026-06-10T12:00:00.000Z");

const THREAD: SupportThread = {
  id: "t-1",
  inboxAddress: "support@acme.test",
  subject: "Where is my refund?",
  fromAddress: "ada@example.test",
  fromName: "Ada Lovelace",
  senderAuthenticated: true,
  userId: "u-1",
  category: "billing",
  priority: "urgent",
  sentiment: "frustrated",
  confidence: 0.82,
  model: "@cf/meta/llama-3.1-8b-instruct",
  classifiedAt: AT,
  archived: true,
  archivedAt: AT,
  archivedBy: "ops@dashboard.test",
  messageCount: 3,
  firstMessageAt: new Date("2026-06-09T00:00:00.000Z"),
  lastMessageAt: AT,
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  updatedAt: AT,
};

/** The shape a brand-new, unclassified, unproven thread actually has — every nullable column empty. */
const UNTOUCHED: SupportThread = {
  ...THREAD,
  fromName: null,
  senderAuthenticated: false,
  userId: null,
  confidence: null,
  model: null,
  classifiedAt: null,
  archived: false,
  archivedAt: null,
  archivedBy: null,
};

const LISTED: ListedThread = { ...THREAD, read: true, snoozedUntil: AT };

const MESSAGE: SupportMessage = {
  id: "m-1",
  threadId: "t-1",
  direction: "inbound",
  mimeMessageId: "<a@example.test>",
  mimeInReplyTo: null,
  mimeReferences: [],
  fromAddress: "ada@example.test",
  fromName: "Ada Lovelace",
  toAddress: "support@acme.test",
  subject: "Where is my refund?",
  textBody: "Still waiting.",
  htmlBody: "<p>Still waiting.</p>",
  emailJobId: null,
  rawKey: "support/raw/t-1/m-1",
  rawBytes: 2048,
  receivedAt: AT,
  createdAt: AT,
};

const SENDER: SenderContext = {
  authenticated: true,
  userId: "u-1",
  name: "Ada Lovelace",
  emailVerified: true,
  purchases: [
    {
      id: "p-1",
      rail: "stripe",
      productId: "pro_monthly",
      status: "refunded",
      environment: "production",
      purchasedAt: new Date("2026-05-01T00:00:00.000Z"),
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      revokedAt: AT,
    },
  ],
  entitlements: [{ key: "pro", active: false, expiresAt: new Date("2026-06-01T00:00:00.000Z"), source: "p-1" }],
};

describe("support response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    accepts(SupportThreadView, threadView(THREAD));
    accepts(SupportThreadView, threadView(UNTOUCHED));
    accepts(SupportListedThreadView, listedThreadView(LISTED));
    accepts(SupportListedThreadView, listedThreadView({ ...UNTOUCHED, read: false, snoozedUntil: null }));
    accepts(SupportMessageView, messageView(MESSAGE));
    accepts(SupportMessageView, messageView({ ...MESSAGE, fromName: null, htmlBody: null, emailJobId: null }));
    accepts(SenderContextView, senderView(SENDER));
  });

  test("an unproven sender's context is empty, and the schema says so without inventing nulls", () => {
    // `name` and `emailVerified` are absent rather than null: both are absent when nothing was looked
    // up, and an explicit null would read as "we looked and there is none".
    const unproven = senderView({ authenticated: false, userId: null, purchases: [], entitlements: [] });
    accepts(SenderContextView, unproven);
    expect(unproven).not.toHaveProperty("name");
    expect(unproven).not.toHaveProperty("emailVerified");
  });

  test("the threading internals and the raw object key leave the Worker in nothing", () => {
    // `rawKey` names the R2 object holding the message exactly as it arrived — the one copy of this
    // data that has had nothing done to it. The schema must not tell a client it is on offer.
    for (const field of ["rawKey", "rawBytes", "mimeMessageId", "mimeInReplyTo", "mimeReferences", "threadId"]) {
      expect(Object.keys(SupportMessageView.shape), field).not.toContain(field);
    }
    // Same for the attachment's storage key: server-derived, precisely so a client cannot name an
    // object or guess the one beside it.
    expect(Object.keys(SupportAttachmentView.shape)).not.toContain("storageKey");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(SupportThreadsResponse, { threads: [listedThreadView(LISTED)], nextCursor: null });
    accepts(SupportThreadsResponse, { threads: [], nextCursor: "eyJpZCI6MX0" });
    accepts(SupportThreadResponse, {
      thread: threadView(THREAD),
      messages: [messageView(MESSAGE)],
      attachments: [
        {
          id: "a-1",
          filename: "receipt.pdf",
          contentType: "application/pdf",
          size: 1024,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          inline: false,
          url: null,
        },
      ],
      sender: senderView(SENDER),
      replies: [
        { key: "refund_issued", label: "Refund issued", category: "billing", body: "Your refund is on its way." },
      ],
    });
    accepts(SupportReplySentResponse, { messageId: "m-2", jobId: "job-1" });
    accepts(SupportFlagsResponse, { ok: true });
    accepts(SupportRepliesResponse, {
      replies: [{ key: "general", label: "Thanks", body: "Thank you for writing in." }],
    });
  });
});
