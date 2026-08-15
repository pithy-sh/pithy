// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { SupportAccountLinkSource, SupportChannel } from "../data/enums";
import type { SupportMessage } from "../data/message";
import type { SupportThread } from "../data/thread";
import type { SenderContext } from "../link/sender";
import type { ListedThread } from "../store/threads";
import * as responses from "./responses";
import {
  SenderContextView,
  SupportAttachmentView,
  SupportFlagsResponse,
  SupportListedThreadView,
  SupportListedThreadViewAsRead,
  SupportMessageView,
  SupportMyMessageView,
  SupportMyThreadResponse,
  SupportMyThreadsResponse,
  SupportMyThreadView,
  SupportRepliesResponse,
  SupportReplySentResponse,
  SupportSubmissionResponse,
  SupportThreadResponse,
  SupportThreadsResponse,
  SupportThreadsResponseAsRead,
  SupportThreadView,
} from "./responses";
import { listedThreadView, messageView, myMessageView, myThreadView, senderView, threadView } from "./views";

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
  channel: "email",
  inboxAddress: "support@acme.test",
  subject: "Where is my refund?",
  fromAddress: "ada@example.test",
  fromName: "Ada Lovelace",
  senderAuthenticated: true,
  userId: "u-1",
  accountLinkSource: "email_address",
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
  accountLinkSource: null,
  confidence: null,
  model: null,
  classifiedAt: null,
  archived: false,
  archivedAt: null,
  archivedBy: null,
};

/**
 * An in-app submission: no envelope, a session-proven link, and — for a project with no mail
 * configured — no address anywhere on the row. The nullable shape the app channel introduced.
 */
const APP_THREAD: SupportThread = {
  ...THREAD,
  id: "t-2",
  channel: "app",
  inboxAddress: null,
  accountLinkSource: "session",
  // They filed it as a billing problem; `THREAD.category` says the classifier called it `billing` too.
  // Overridden per-test where the disagreement is the point.
  declaredCategory: "billing",
};

const LISTED: ListedThread = { ...THREAD, read: true, snoozedUntil: AT };

const MESSAGE: SupportMessage = {
  id: "m-1",
  threadId: "t-1",
  direction: "inbound",
  channel: "email" as const,
  submittedByUserId: null,
  context: null,
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

/** The same message, filed from inside the app: context, a submitter, and no envelope recipient. */
const APP_MESSAGE: SupportMessage = {
  ...MESSAGE,
  id: "m-2",
  threadId: "t-2",
  channel: "app",
  submittedByUserId: "u-1",
  context: { screen: "reports", appVersion: "2.4.1", platform: "web", environment: "prod", locale: "en-GB" },
  toAddress: null,
  htmlBody: null,
  rawKey: null,
  rawBytes: null,
};

describe("support response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    accepts(SupportThreadView, threadView(THREAD));
    accepts(SupportThreadView, threadView(UNTOUCHED));
    accepts(SupportThreadView, threadView(APP_THREAD));
    accepts(SupportMessageView, messageView(APP_MESSAGE));
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

  test("the console can tell what the submitter said from what the classifier decided", () => {
    // `pithy-sh/pithy#375`. Collapsing these is how a chooser becomes decoration: the operator sees
    // one word and cannot tell whether a person claimed it or a model concluded it, and the same
    // action follows from very different evidence. Two fields, both projected, neither derived.
    expect(threadView(APP_THREAD).declaredCategory).toBe("billing");
    expect(threadView(APP_THREAD).category).toBe("billing");

    // The row worth having: they say billing, the model says bug_report. Both survive the projection.
    const disputed = threadView({ ...APP_THREAD, category: "bug_report" });
    expect(disputed).toMatchObject({ declaredCategory: "billing", category: "bug_report" });

    // Mail. Nobody was asked, so nobody said — and null is not the catch-all key.
    expect(threadView(THREAD).declaredCategory).toBeNull();
    expect(threadView(THREAD).category).toBe("billing");
  });

  test("the console can tell a session-proven link from a header-inferred one", () => {
    // The whole argument of the in-app channel: a `From:` header is a claim and a session is not, so
    // the two links must not be one indistinguishable boolean. `senderAuthenticated` is true on both
    // of these — it says *may we believe this*, and `accountLinkSource` says *how did we come to*.
    expect(threadView(THREAD).accountLinkSource).toBe("email_address");
    expect(threadView(APP_THREAD).accountLinkSource).toBe("session");
    expect(threadView(UNTOUCHED).accountLinkSource).toBeNull();
    expect(threadView(THREAD).senderAuthenticated).toBe(threadView(APP_THREAD).senderAuthenticated);
  });

  test("the submitter's own view carries nothing an operator would see", () => {
    accepts(SupportMyThreadView, myThreadView(APP_THREAD));
    accepts(SupportMyMessageView, myMessageView(APP_MESSAGE, []));

    // A machine's judgement about the person, the private flags of whoever is triaging, and the link
    // that decides whether an operator sees their purchase history. None of it is the submitter's, and
    // a projection built by omitting fields from the operator's view would disclose the next column
    // somebody adds without anyone deciding to.
    for (const field of [
      "category",
      "priority",
      "sentiment",
      "confidence",
      "model",
      "classifiedAt",
      "userId",
      "accountLinkSource",
      "senderAuthenticated",
      "archivedBy",
      "inboxAddress",
      "fromAddress",
      "read",
      "snoozedUntil",
    ]) {
      expect(Object.keys(SupportMyThreadView.shape), field).not.toContain(field);
    }
    // And the answer carries no operator identity either: who replied is a name in the body if they
    // signed it, never an account.
    for (const field of ["fromAddress", "fromName", "toAddress", "emailJobId", "submittedByUserId"]) {
      expect(Object.keys(SupportMyMessageView.shape), field).not.toContain(field);
    }
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
    accepts(SupportReplySentResponse, { channel: "email", messageId: "m-2", jobId: "job-1" });
    accepts(SupportReplySentResponse, { channel: "app", messageId: "m-3" });
    accepts(SupportFlagsResponse, { ok: true });
    accepts(SupportRepliesResponse, {
      replies: [{ key: "general", label: "Thanks", body: "Thank you for writing in." }],
    });
    accepts(SupportSubmissionResponse, { threadId: "t-2", messageId: "m-2", opened: true, attachments: 1 });
    accepts(SupportMyThreadsResponse, { threads: [myThreadView(APP_THREAD)], nextCursor: null });
    accepts(SupportMyThreadResponse, {
      thread: myThreadView(APP_THREAD),
      messages: [myMessageView(APP_MESSAGE, [])],
    });
  });

  test("a reply response has to say how it was delivered, and only one arm has a job", () => {
    // "Sent by email" and "waiting in the app" are different promises about when somebody reads the
    // answer, so the shape makes a client branch to read either one. Without the discriminant there is
    // no arm to validate against at all.
    expect(SupportReplySentResponse.safeParse({ messageId: "m-2", jobId: "job-1" }).success).toBe(false);
    // And an in-app delivery cannot be handed a job id to render as proof it went out — the arm has no
    // such field, so it does not survive the parse. `ReplyResult` refuses the same thing at compile
    // time: `result.jobId` does not exist until `channel` has been narrowed.
    expect(SupportReplySentResponse.parse({ channel: "app", messageId: "m-3", jobId: "job-1" })).toEqual({
      channel: "app",
      messageId: "m-3",
    });
  });
});

/**
 * The reader's contracts, against the two obligations they exist to keep apart.
 *
 * Every test below is one half of a pair: what the producer's schema must still refuse, and what the
 * reader's must now survive. Neither half proves anything alone — a shape that tolerates an unknown
 * member is only a contract if the strict one still refuses it, and a strict one is only a problem if
 * something else can read past it.
 */

/** The six reader's contracts this capability publishes. Frozen: a seventh has to be written down. */
const READERS_CONTRACTS: readonly string[] = [
  "SupportArchiveResponseAsRead",
  "SupportListedThreadViewAsRead",
  "SupportMessageViewAsRead",
  "SupportThreadResponseAsRead",
  "SupportThreadViewAsRead",
  "SupportThreadsResponseAsRead",
];

/**
 * Every enum reachable in a schema, by path.
 *
 * It walks unions as well as the wrappers `asRead` rewrites, deliberately: a gate that could only see
 * the shapes the rewrite handles would report a clean bill of health for the one arrangement the
 * rewrite cannot reach, which is the arrangement worth catching.
 */
function enumsIn(schema: z.ZodType, path: string, found: string[] = []): string[] {
  if (schema instanceof z.ZodEnum) found.push(path);
  else if (schema instanceof z.ZodObject)
    for (const [key, field] of Object.entries(schema.shape)) enumsIn(field as z.ZodType, `${path}.${key}`, found);
  else if (schema instanceof z.ZodArray) enumsIn(schema.element as z.ZodType, `${path}[]`, found);
  else if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
    enumsIn(schema.unwrap() as z.ZodType, path, found);
  else if (schema instanceof z.ZodUnion)
    schema.options.forEach((option, index) => {
      enumsIn(option as z.ZodType, `${path}|${index}`, found);
    });
  return found;
}

/** What `responses.ts` publishes, read by name so the gate walks the module rather than a list of it. */
const published: Record<string, unknown> = { ...responses };

/** One inbox row carrying values no enum of this capability declares. */
function stranger(): Record<string, unknown> {
  return { ...listedThreadView(LISTED), channel: "sms", accountLinkSource: "oauth", priority: "blocker" };
}

describe("the reader's contract beside the producer's", () => {
  test("the producer's schemas still refuse a member they do not declare", () => {
    expect(SupportListedThreadView.safeParse(stranger()).success).toBe(false);
    expect(SupportThreadsResponse.safeParse({ threads: [stranger()], nextCursor: null }).success).toBe(false);
    // And one stranger among four costs the producer's schema the whole page — the behaviour the
    // reader's contract exists to change, stated here so the change is visible as a difference.
    const page = { threads: [listedThreadView(LISTED), stranger()], nextCursor: null };
    expect(SupportThreadsResponse.safeParse(page).success).toBe(false);
    expect(SupportThreadsResponseAsRead.safeParse(page).success).toBe(true);
  });

  test("the reader's tolerates the member, hands it back verbatim, and leaves it markable", () => {
    const parsed = SupportThreadsResponseAsRead.parse({ threads: [stranger()], nextCursor: null });
    const thread = parsed.threads[0];
    expect(thread?.channel).toBe("sms");
    expect(thread?.accountLinkSource).toBe("oauth");
    expect(thread?.priority).toBe("blocker");
    // Marked, not mapped. The enum is still the authority on what a value means, and it says no — which
    // is the whole licence a client needs to render the row and say it does not recognise this.
    expect(SupportChannel.safeParse(thread?.channel).success).toBe(false);
    expect(SupportAccountLinkSource.safeParse(thread?.accountLinkSource).success).toBe(false);
    // A member the enum does declare still reads as itself, and the row is otherwise untouched.
    expect(SupportThreadsResponseAsRead.parse({ threads: [listedThreadView(LISTED)], nextCursor: null })).toEqual({
      threads: [listedThreadView(LISTED)],
      nextCursor: null,
    });
  });

  test("a malformed response still fails under the reader's contract", () => {
    const malformed: unknown[] = [
      "not an object",
      null,
      { threads: "nope", nextCursor: null },
      { threads: [stranger()] },
      { threads: [stranger()], nextCursor: 7 },
      // A row missing the fields a record is made of.
      { threads: [{ id: "t-9", channel: "sms" }], nextCursor: null },
      // A channel that is not a member of anything — widened is still typed.
      { threads: [{ ...stranger(), channel: 7 }], nextCursor: null },
      { threads: [{ ...stranger(), channel: null }], nextCursor: null },
      // A confidence outside 0..1, and a count that is not a whole number.
      { threads: [{ ...stranger(), confidence: 5 }], nextCursor: null },
      { threads: [{ ...stranger(), messageCount: 1.5 }], nextCursor: null },
      // A date that is not one.
      { threads: [{ ...stranger(), lastMessageAt: "yesterday" }], nextCursor: null },
      // A boolean sent as the string a template would render it as.
      { threads: [{ ...stranger(), senderAuthenticated: "true" }], nextCursor: null },
    ];
    for (const value of malformed) {
      expect(SupportThreadsResponseAsRead.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  test("every field with no enum under it is the producer's own schema instance, not a copy", () => {
    // pithy-sh/pithy#113: a client holding its own mirror of a projection drifts the first time a field
    // lands. A reader's contract that copied the untouched fields would be that mirror with a better
    // excuse, so it shares them by identity and a field added upstream lands here with nothing to edit.
    const reader: Record<string, unknown> = SupportListedThreadViewAsRead.shape;
    const widened: string[] = [];
    for (const [key, field] of Object.entries<unknown>(SupportListedThreadView.shape)) {
      if (reader[key] === field) continue;
      widened.push(key);
    }
    // The four fields an inbox row states as an enum, and no others. Written down rather than derived:
    // a fifth enum landing upstream widens this row, and that is a fact worth reading in a diff.
    expect(widened.sort()).toEqual(["accountLinkSource", "channel", "priority", "sentiment"]);
    expect(SupportThreadsResponseAsRead.shape.nextCursor).toBe(SupportThreadsResponse.shape.nextCursor);
  });

  test("no reader's contract has an enum left anywhere in it, and its producer has one", () => {
    for (const name of READERS_CONTRACTS) {
      const reader = published[name];
      const producer = published[name.replace(/AsRead$/, "")];
      expect(reader, name).toBeInstanceOf(z.ZodType);
      expect(producer, name).toBeInstanceOf(z.ZodType);
      // The gate. A widening that missed a field, or a field that lands later carrying an enum, is a
      // path in this list — and a reader that still refuses one member of it refuses the whole response.
      expect(enumsIn(reader as z.ZodType, name), name).toEqual([]);
      // Anti-vacuity: the producer it was derived from really does hold an enum, so an empty list is a
      // rewrite that happened rather than a walk that found nothing to look at.
      expect(enumsIn(producer as z.ZodType, name).length, name).toBeGreaterThan(0);
    }
  });

  test("the published set of reader's contracts is the one that is written down", () => {
    const exported = Object.keys(published)
      .filter((name) => name.endsWith("AsRead"))
      .sort();
    expect(exported).toEqual([...READERS_CONTRACTS].sort());
  });
});
