// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { EXAMPLE_ADA, EXAMPLE_ALAN, EXAMPLE_GRACE } from "@pithy-sh/core/src/seed/exampleIdentities";
import { d1SeedGroup, defineSeed, type SeedSet } from "@pithy-sh/core/src/seed/seed";
import { SupportClassification } from "../data/classification";
import { SupportMessage } from "../data/message";
import { SUPPORT_CLASSIFICATIONS_TABLE, SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE } from "../data/tables";
import { SupportThread } from "../data/thread";

/**
 * Three conversations for the canonical example cast, spread across the shapes a dashboard has to
 * render.
 *
 * **Ada** is angry about a double charge — `billing`, `urgent`, and she is the one with a live Apple
 * subscription in the payments seed, so a thread view opened on her shows the linkage working end to
 * end rather than an empty panel. **Grace** cannot sign in — `account_access`, `normal`, two
 * messages, so the thread view has an actual conversation in it and the reply path has something
 * threaded to attach to. **Alan** sent a feature request that has been dealt with — `feature_request`,
 * `low`, `positive`, and **archived**, so the done pile is not empty on a fresh backend and the
 * archived filter is demonstrably doing something.
 *
 * That is one row per priority, three of the four sentiments, three categories, and both sides of
 * `archived` — the states anything reading these tables has to handle, without anybody authoring a
 * fixture first.
 *
 * **Everything is fixed — the ids and the clock.** `pithy seed` is `INSERT OR IGNORE`, so a generated
 * UUID would give Ada a second complaint on every run.
 *
 * **No attachments, and no raw messages.** Both would mean seeding R2 objects the D1 rows point at,
 * and a fixture whose rows name bytes that are not there is worse than one that claims less. The
 * classifications are seeded because they are the interesting half: a thread carries a model id, so
 * the seed shows what "which rows came from which model" looks like before anybody has run one.
 *
 * Composed in only when the project turns on `seed.includeExamples`, and only for `dev` and
 * `staging` — an example fixture never targets prod, whatever that setting says.
 */

/** Where this set sorts. After auth's users (100) and payments' purchases (250), which it links to. */
const SUPPORT_EXAMPLE_SEED_ORDER = 260;

/** Fixed ids, so the fixture is idempotent and a classification cannot drift off its thread. */
const BILLING_THREAD_ID = "a1b2c3d4-0001-4a11-9c01-0e1f2a3b4c50";
const ACCESS_THREAD_ID = "a1b2c3d4-0002-4a11-9c01-0e1f2a3b4c51";
const FEATURE_THREAD_ID = "a1b2c3d4-0003-4a11-9c01-0e1f2a3b4c52";

const BILLING_MESSAGE_ID = "b1b2c3d4-0001-4a11-9c01-0e1f2a3b4c60";
const ACCESS_MESSAGE_ID = "b1b2c3d4-0002-4a11-9c01-0e1f2a3b4c61";
const ACCESS_REPLY_ID = "b1b2c3d4-0003-4a11-9c01-0e1f2a3b4c62";
const FEATURE_MESSAGE_ID = "b1b2c3d4-0004-4a11-9c01-0e1f2a3b4c63";

const BILLING_CLASSIFICATION_ID = "c1b2c3d4-0001-4a11-9c01-0e1f2a3b4c70";
const ACCESS_CLASSIFICATION_ID = "c1b2c3d4-0002-4a11-9c01-0e1f2a3b4c71";
const FEATURE_CLASSIFICATION_ID = "c1b2c3d4-0003-4a11-9c01-0e1f2a3b4c72";

/** The inbox these threads arrived on — a subdomain, which is the only safe shape for a real one. */
const INBOX = "support@help.example.com";

/** The model the seeded classifications claim to have come from. */
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** One fixed moment. The demo is about state, not about a calendar. */
const AT = new Date("2026-01-10T09:00:00.000Z");
const LATER = new Date("2026-01-10T11:30:00.000Z");
const ARCHIVED_AT = new Date("2026-01-11T16:00:00.000Z");

export const supportExampleSeed: SeedSet = defineSeed({
  name: "example",
  order: SUPPORT_EXAMPLE_SEED_ORDER,
  environments: ["dev", "staging"],
  example: true,
  d1: [
    d1SeedGroup("app", SUPPORT_THREADS_TABLE, SupportThread, [
      {
        id: BILLING_THREAD_ID,
        inboxAddress: INBOX,
        subject: "I was charged twice this month",
        fromAddress: EXAMPLE_ADA.email,
        fromName: EXAMPLE_ADA.name,
        // Authenticated, which is what lets the seeded thread show a real customer link.
        senderAuthenticated: true,
        userId: EXAMPLE_ADA.id,
        category: "billing",
        priority: "urgent",
        sentiment: "angry",
        confidence: 0.94,
        model: MODEL,
        classifiedAt: AT,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 1,
        firstMessageAt: AT,
        lastMessageAt: AT,
        createdAt: AT,
        updatedAt: AT,
      },
      {
        id: ACCESS_THREAD_ID,
        inboxAddress: INBOX,
        subject: "Magic link never arrives",
        fromAddress: EXAMPLE_GRACE.email,
        fromName: EXAMPLE_GRACE.name,
        senderAuthenticated: true,
        userId: EXAMPLE_GRACE.id,
        category: "account_access",
        priority: "normal",
        sentiment: "frustrated",
        confidence: 0.81,
        model: MODEL,
        classifiedAt: AT,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        // Two: her message and the answer, so a thread view has a conversation in it.
        messageCount: 2,
        firstMessageAt: AT,
        lastMessageAt: LATER,
        createdAt: AT,
        updatedAt: LATER,
      },
      {
        id: FEATURE_THREAD_ID,
        inboxAddress: INBOX,
        subject: "Could you add CSV export?",
        fromAddress: EXAMPLE_ALAN.email,
        fromName: EXAMPLE_ALAN.name,
        senderAuthenticated: true,
        userId: EXAMPLE_ALAN.id,
        category: "feature_request",
        priority: "low",
        sentiment: "positive",
        confidence: 0.88,
        model: MODEL,
        classifiedAt: AT,
        // Done. The archived filter needs something to find, and the done pile needs to not be empty
        // on a fresh backend.
        archived: true,
        archivedAt: ARCHIVED_AT,
        archivedBy: "example-dashboard",
        messageCount: 1,
        firstMessageAt: AT,
        lastMessageAt: AT,
        createdAt: AT,
        updatedAt: ARCHIVED_AT,
      },
    ]),
    d1SeedGroup("app", SUPPORT_MESSAGES_TABLE, SupportMessage, [
      {
        id: BILLING_MESSAGE_ID,
        threadId: BILLING_THREAD_ID,
        direction: "inbound",
        mimeMessageId: "seed-billing-1@example.com",
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: EXAMPLE_ADA.email,
        fromName: EXAMPLE_ADA.name,
        toAddress: INBOX,
        subject: "I was charged twice this month",
        textBody:
          "My card shows two charges for the same subscription on the 3rd. I have only ever had one account. Please refund the duplicate.",
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: AT,
        createdAt: AT,
      },
      {
        id: ACCESS_MESSAGE_ID,
        threadId: ACCESS_THREAD_ID,
        direction: "inbound",
        mimeMessageId: "seed-access-1@example.com",
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: EXAMPLE_GRACE.email,
        fromName: EXAMPLE_GRACE.name,
        toAddress: INBOX,
        subject: "Magic link never arrives",
        textBody:
          "I have asked for a sign-in link four times today and none of them have arrived. I checked spam. Is something broken?",
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: AT,
        createdAt: AT,
      },
      {
        id: ACCESS_REPLY_ID,
        threadId: ACCESS_THREAD_ID,
        direction: "outbound",
        // Null, exactly as the real reply path leaves it: Cloudflare assigns the sent `Message-ID`
        // and never tells the enqueuer, so a seeded value here would model something that cannot
        // happen.
        mimeMessageId: null,
        mimeInReplyTo: "seed-access-1@example.com",
        mimeReferences: ["seed-access-1@example.com"],
        fromAddress: INBOX,
        fromName: null,
        toAddress: EXAMPLE_GRACE.email,
        subject: "Re: Magic link never arrives",
        textBody:
          "Hi Grace,\n\nI found the problem — your address had bounced earlier in the week and was on our suppression list. I have cleared it. Try again and it should arrive within a minute.\n\nSorry for the trouble.\n",
        htmlBody: null,
        emailJobId: "seed-email-job-access-1",
        rawKey: null,
        rawBytes: null,
        receivedAt: LATER,
        createdAt: LATER,
      },
      {
        id: FEATURE_MESSAGE_ID,
        threadId: FEATURE_THREAD_ID,
        direction: "inbound",
        mimeMessageId: "seed-feature-1@example.com",
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: EXAMPLE_ALAN.email,
        fromName: EXAMPLE_ALAN.name,
        toAddress: INBOX,
        subject: "Could you add CSV export?",
        textBody:
          "Loving the product. The one thing I miss is being able to export my data as CSV for a spreadsheet. No rush.",
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: AT,
        createdAt: AT,
      },
    ]),
    d1SeedGroup("app", SUPPORT_CLASSIFICATIONS_TABLE, SupportClassification, [
      {
        id: BILLING_CLASSIFICATION_ID,
        threadId: BILLING_THREAD_ID,
        messageId: BILLING_MESSAGE_ID,
        category: "billing",
        priority: "urgent",
        sentiment: "angry",
        confidence: 0.94,
        model: MODEL,
        createdAt: AT,
      },
      {
        id: ACCESS_CLASSIFICATION_ID,
        threadId: ACCESS_THREAD_ID,
        messageId: ACCESS_MESSAGE_ID,
        category: "account_access",
        priority: "normal",
        sentiment: "frustrated",
        confidence: 0.81,
        model: MODEL,
        createdAt: AT,
      },
      {
        id: FEATURE_CLASSIFICATION_ID,
        threadId: FEATURE_THREAD_ID,
        messageId: FEATURE_MESSAGE_ID,
        category: "feature_request",
        priority: "low",
        sentiment: "positive",
        confidence: 0.88,
        model: MODEL,
        createdAt: AT,
      },
    ]),
  ],
});
