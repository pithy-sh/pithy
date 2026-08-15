// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SupportMessage } from "../data/message";
import type { SupportThread } from "../data/thread";
import type { SenderContext } from "../link/sender";
import type { ListedThread } from "../store/threads";
import type {
  SenderContextView,
  SupportAttachmentView,
  SupportListedThreadView,
  SupportMessageView,
  SupportMyMessageView,
  SupportMyThreadView,
  SupportThreadView,
} from "./responses";

/**
 * The projections between a support row and the wire.
 *
 * Every return type is `z.output` of the matching object in `responses.ts`, so what this Worker sends
 * and what a management client validates against are one declaration. A field added to one and not
 * the other does not compile.
 *
 * **These convert dates to ISO-8601 strings, and that changes nothing on the wire.** A `Date` handed
 * to `c.json` serializes as an ISO string already — so the bytes were always this, while the type
 * claimed a `Date` no client ever received and no schema could describe. Converting explicitly is
 * what makes the response statable, and it is the whole reason the fields could be typed at all.
 *
 * **A row is never spread.** Each projection names its fields, so a column added to
 * `pithy_support_threads` is disclosed by a decision rather than by default — which is the same rule
 * every other capability's admin surface follows, and the one a `SELECT *` handed to `c.json` breaks
 * silently.
 */

/** An ISO string, or null. */
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Project one thread row. */
export function threadView(thread: SupportThread): SupportThreadView {
  return {
    id: thread.id,
    channel: thread.channel,
    inboxAddress: thread.inboxAddress ?? null,
    subject: thread.subject,
    fromAddress: thread.fromAddress,
    fromName: thread.fromName ?? null,
    senderAuthenticated: thread.senderAuthenticated,
    userId: thread.userId ?? null,
    accountLinkSource: thread.accountLinkSource ?? null,
    declaredCategory: thread.declaredCategory ?? null,
    category: thread.category,
    priority: thread.priority,
    sentiment: thread.sentiment,
    confidence: thread.confidence ?? null,
    model: thread.model ?? null,
    classifiedAt: iso(thread.classifiedAt),
    archived: thread.archived,
    archivedAt: iso(thread.archivedAt),
    archivedBy: thread.archivedBy ?? null,
    messageCount: thread.messageCount,
    firstMessageAt: thread.firstMessageAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/** Project one thread for the inbox, carrying this viewer's own read and snooze state. */
export function listedThreadView(thread: ListedThread): SupportListedThreadView {
  return { ...threadView(thread), read: thread.read, snoozedUntil: iso(thread.snoozedUntil) };
}

/**
 * Project one message.
 *
 * The threading internals — `mimeMessageId`, `mimeInReplyTo`, `mimeReferences`, `rawKey`, `rawBytes` —
 * are dropped. They are how a reply is stitched to its parent, and an operator would never act on one.
 * `rawKey` in particular is the R2 object holding the message exactly as it arrived, which is the one
 * copy of this data that has had nothing done to it.
 */
export function messageView(message: SupportMessage): SupportMessageView {
  return {
    id: message.id,
    direction: message.direction,
    channel: message.channel,
    context: message.context ?? null,
    fromAddress: message.fromAddress ?? null,
    fromName: message.fromName ?? null,
    toAddress: message.toAddress ?? null,
    subject: message.subject,
    // Already sanitised at ingest. The raw original stays in R2 and is never served here.
    htmlBody: message.htmlBody ?? null,
    textBody: message.textBody,
    emailJobId: message.emailJobId ?? null,
    receivedAt: message.receivedAt.toISOString(),
  };
}

/**
 * Project one thread for the person who opened it.
 *
 * **Built from scratch rather than from {@link threadView}, and that is the security boundary.** A
 * submitter's view derived by omitting fields from an operator's would disclose the next column
 * somebody adds, silently, on the day they add it — the failure would be a default rather than a
 * decision. Starting from nothing means a field reaches a customer only because somebody wrote it
 * here.
 *
 * So: no classification, no priority, no sentiment, no confidence, no model, no viewer flags, no
 * account link, no `archivedBy`, no addresses. What is left is their conversation.
 */
export function myThreadView(thread: SupportThread): SupportMyThreadView {
  return {
    id: thread.id,
    subject: thread.subject,
    resolved: thread.archived,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
  };
}

/** Project one message for the person in the conversation. Their own attachments ride along. */
export function myMessageView(message: SupportMessage, attachments: SupportAttachmentView[]): SupportMyMessageView {
  return {
    id: message.id,
    direction: message.direction,
    // `textBody` on both sides. An answer is composed as plain text by `reply/send.ts`, and a
    // submission was plain text when it arrived — so there is no `htmlBody` to hand back, and nothing
    // here needs a sanitiser because nothing here is markup.
    body: message.textBody,
    context: message.context ?? null,
    attachments,
    sentAt: message.receivedAt.toISOString(),
  };
}

/** Project the customer context beside a conversation. */
export function senderView(sender: SenderContext): SenderContextView {
  return {
    authenticated: sender.authenticated,
    userId: sender.userId,
    // Spread rather than set to null: both are absent for an unproven sender, and an explicit null
    // would read as "we looked and there is none" rather than "we did not look".
    ...(sender.name === undefined ? {} : { name: sender.name }),
    ...(sender.emailVerified === undefined ? {} : { emailVerified: sender.emailVerified }),
    purchases: sender.purchases.map((purchase) => ({
      id: purchase.id,
      rail: purchase.rail,
      productId: purchase.productId,
      status: purchase.status,
      environment: purchase.environment,
      purchasedAt: purchase.purchasedAt.toISOString(),
      expiresAt: iso(purchase.expiresAt),
      revokedAt: iso(purchase.revokedAt),
    })),
    entitlements: sender.entitlements.map((entitlement) => ({
      key: entitlement.key,
      active: entitlement.active,
      expiresAt: iso(entitlement.expiresAt),
      source: entitlement.source,
    })),
  };
}
