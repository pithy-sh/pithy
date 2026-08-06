// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SupportMessageDirection, SupportPriority, SupportSentiment } from "../data/enums";

/**
 * What the support routes return, as Zod objects a management client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help — so every client that had only an interface hand-wrote a mirror, and the mirror drifted
 * the first time a field landed here.
 *
 * **Dates are ISO-8601 strings, and that is not a change.** These handlers used to hand `Date` objects
 * to `c.json`, which serializes them as ISO strings anyway — so the bytes on the wire were always
 * this, while the type said otherwise and no schema could describe it. `views.ts` now converts
 * explicitly, which is what makes the shape statable at all.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 */

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/** One conversation, as the inbox and the reading pane show it. */
export const SupportThreadView = z
  .object({
    id: z.string().describe("The thread's UUID — what every other route on this surface takes."),
    inboxAddress: z.string().describe("The support address this thread arrived on, lowercased."),
    subject: z.string().describe("The subject of the message that opened the thread. Later replies never rewrite it."),
    fromAddress: z.string().describe("The sender's address, lowercased."),
    fromName: z.string().nullable().describe("The sender's display name, or null. Untrusted text; render it escaped."),
    senderAuthenticated: z
      .boolean()
      .describe(
        "Whether the `From:` header was proved to belong to the sender. False means unproven, not forged — and it is what withholds the customer link.",
      ),
    userId: z.string().nullable().describe("The user this sender resolves to, or null when nobody or unproven."),
    category: z.string().describe("The current category key, from this project's own federated taxonomy."),
    priority: SupportPriority.describe("How fast this thread needs a human."),
    sentiment: SupportSentiment.describe("How the sender sounds — the churn signal."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("The model's confidence in the current classification, or null until one lands."),
    model: z.string().nullable().describe("The Workers AI model that produced the classification, or null."),
    classifiedAt: z.iso
      .datetime()
      .nullable()
      .describe("When the classification was written, ISO-8601; null until it is."),
    archived: z.boolean().describe("Done. One shared boolean, not per viewer."),
    archivedAt: z.iso.datetime().nullable().describe("When it was last archived, ISO-8601; null while open."),
    archivedBy: z
      .string()
      .nullable()
      .describe(
        "The control-plane subject that archived it, for convenience only — the answer to 'who marked this done' comes from the audit trail.",
      ),
    messageCount: z.number().int().describe("How many messages the thread holds, inbound and outbound together."),
    firstMessageAt: z.iso.datetime().describe("When the thread opened, ISO-8601."),
    lastMessageAt: z.iso.datetime().describe("When the thread last moved, ISO-8601. The inbox sorts on this."),
    createdAt: z.iso.datetime().describe("When the thread row was created, ISO-8601."),
    updatedAt: z.iso.datetime().describe("When the thread row was last written, ISO-8601."),
  })
  .describe("One support conversation, as a management client sees it.");
export type SupportThreadView = z.output<typeof SupportThreadView>;

/**
 * A thread in the inbox listing — the thread plus this viewer's own private state.
 *
 * Re-described after `.extend()`: extending builds a new schema, and a description does not follow it.
 */
export const SupportListedThreadView = SupportThreadView.extend({
  read: z.boolean().describe("Whether this viewer has read it. False when they have no flag row, the common case."),
  snoozedUntil: z.iso.datetime().nullable().describe("When this viewer's snooze expires, ISO-8601, or null."),
}).describe("One conversation in the inbox, carrying the calling viewer's own read and snooze state.");
export type SupportListedThreadView = z.output<typeof SupportListedThreadView>;

/** One message in a conversation. */
export const SupportMessageView = z
  .object({
    id: z.string().describe("The message's UUID — Pithy's id, not the sender's."),
    direction: SupportMessageDirection.describe("`inbound` from the customer, `outbound` from this Worker."),
    fromAddress: z.string().describe("The sender's address, lowercased."),
    fromName: z.string().nullable().describe("The sender's display name, or null. Untrusted text."),
    toAddress: z.string().describe("The address this message was addressed to, lowercased."),
    subject: z.string().describe("This message's own subject, which may differ from the thread's."),
    textBody: z.string().describe("The plain-text body."),
    htmlBody: z
      .string()
      .nullable()
      .describe(
        "The sanitised HTML body, or null. Sanitised at ingest; the raw original stays in R2 and is never served.",
      ),
    emailJobId: z.string().nullable().describe("The email job an outbound message was sent as, or null."),
    receivedAt: z.iso.datetime().describe("When the message arrived or was sent, ISO-8601."),
  })
  .describe("One message in a conversation, with the threading internals dropped.");
export type SupportMessageView = z.output<typeof SupportMessageView>;

/** One attachment — metadata plus a short-lived URL, never the storage key. */
export const SupportAttachmentView = z
  .object({
    id: z.string().describe("The attachment's UUID."),
    filename: z.string().describe("The filename as it arrived, sanitised."),
    contentType: z.string().describe("The declared content type."),
    size: z.number().int().describe("The size in bytes."),
    sha256: z.string().describe("The content digest, so a client can tell two identical attachments apart from one."),
    inline: z.boolean().describe("Whether it was referenced inline in the HTML body rather than attached."),
    url: z
      .string()
      .nullable()
      .describe(
        "A signed URL valid for a few minutes, or null when no credentials were available to sign one. The `storageKey` is never here: it is server-derived precisely so a client cannot name an object or guess the one beside it.",
      ),
  })
  .describe("One attachment as a client receives it — metadata and a signed URL, never the storage key.");
export type SupportAttachmentView = z.output<typeof SupportAttachmentView>;

/** One of the sender's purchases, flattened to what a support console renders. */
export const SenderPurchaseView = z
  .object({
    id: z.string().describe("The purchase row id."),
    rail: z.string().describe("Which rail it went through — `apple`, `google`, or `stripe`."),
    productId: z.string().describe("The Pithy product key."),
    status: z.string().describe("Its lifecycle state — `active`, `refunded`, `expired`, and so on."),
    environment: z.string().describe("Whether it happened in the store's sandbox rather than production."),
    purchasedAt: z.iso.datetime().describe("When it was bought, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When it runs out, ISO-8601; null for something owned forever."),
    revokedAt: z.iso.datetime().nullable().describe("When it was refunded or revoked, ISO-8601; null while it stands."),
  })
  .describe("One purchase beside the sender, so an operator answering a billing question need not go and look.");
export type SenderPurchaseView = z.output<typeof SenderPurchaseView>;

/** One of the sender's entitlements, lapsed ones included and marked inactive. */
export const SenderEntitlementView = z
  .object({
    key: z.string().describe("The entitlement key."),
    active: z.boolean().describe("Whether it granted when the projection last wrote it."),
    expiresAt: z.iso.datetime().nullable().describe("When the grant lapses, ISO-8601; null when it never does."),
    source: z.string().nullable().describe("Opaque provenance — a purchase id, or a support grant."),
  })
  .describe("One entitlement beside the sender. Lapsed ones are here too — a paywall wants to say when Pro ended.");
export type SenderEntitlementView = z.output<typeof SenderEntitlementView>;

/**
 * What the app already knows about the sender. Derived at read time, so it is always current.
 *
 * **Everything but `authenticated` is empty when the sender is unproven.** The whole value of the
 * panel is that an operator trusts it, so it must not be populated from an address anybody could have
 * written — that is what turns a spoofed message into support-driven account takeover.
 */
export const SenderContextView = z
  .object({
    authenticated: z.boolean().describe("Whether the `From:` header was proved to belong to the sender."),
    userId: z.string().nullable().describe("The linked user id, or null when this address belongs to nobody."),
    name: z.string().optional().describe("The account's display name, when auth is composed and the sender is known."),
    emailVerified: z.boolean().optional().describe("Whether the account has verified this address."),
    purchases: z.array(SenderPurchaseView).describe("Their purchase history, newest first, bounded. Empty when none."),
    entitlements: z.array(SenderEntitlementView).describe("Their entitlements, lapsed ones marked inactive."),
  })
  .describe("The customer context beside a conversation, withheld entirely when the sender is unproven.");
export type SenderContextView = z.output<typeof SenderContextView>;

/** One canned reply, ordered for this thread's category. */
export const SupportReplyView = z
  .object({
    key: z.string().describe("The snippet's key in the catalog."),
    label: z.string().describe("What the picker shows, e.g. `Refund issued`."),
    category: z.string().optional().describe("The category it is offered first for. Absent means always offered."),
    body: z.string().describe("The reply text, ready to edit."),
  })
  .describe("One canned reply from the effective catalog.");
export type SupportReplyView = z.output<typeof SupportReplyView>;

/** `GET {base}/threads`. */
export const SupportThreadsResponse = z
  .object({
    threads: z.array(SupportListedThreadView).describe("The page, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the inbox, as one viewer sees it.");
export type SupportThreadsResponse = z.output<typeof SupportThreadsResponse>;

/** `GET {base}/threads/:id`. */
export const SupportThreadResponse = z
  .object({
    thread: SupportThreadView.describe("The conversation."),
    messages: z.array(SupportMessageView).describe("Its messages, oldest first — a conversation reads downward."),
    attachments: z.array(SupportAttachmentView).describe("Its attachments, across every message."),
    sender: SenderContextView.describe("What the app already knows about the sender."),
    replies: z.array(SupportReplyView).describe("The canned replies, ordered for this thread's category."),
  })
  .describe("A whole conversation, with the customer context and the replies worth offering on it.");
export type SupportThreadResponse = z.output<typeof SupportThreadResponse>;

/**
 * `POST {base}/threads/:id/archive`.
 *
 * The thread itself rather than an envelope around it: archiving is a write whose entire result is the
 * new state of the row, and a pane re-renders from it.
 */
export const SupportArchiveResponse = SupportThreadView.describe("The conversation, as the archive left it.");
export type SupportArchiveResponse = z.output<typeof SupportArchiveResponse>;

/** `POST {base}/threads/:id/reply`. */
export const SupportReplySentResponse = z
  .object({
    messageId: z.string().describe("The outbound message row this reply created."),
    jobId: z.string().describe("The email job it was enqueued as. The send itself is a Workflow's job."),
  })
  .describe("The reply that was queued, by message and by mail job.");
export type SupportReplySentResponse = z.output<typeof SupportReplySentResponse>;

/** `POST {base}/threads/:id/reclassify`. */
export const SupportReclassifiedResponse = z
  .object({
    messageId: z.string().describe("The latest inbound message the classifier was started against."),
  })
  .describe("Which message a reclassification was started for.");
export type SupportReclassifiedResponse = z.output<typeof SupportReclassifiedResponse>;

/**
 * `POST {base}/threads/:id/flags`.
 *
 * `ok` and nothing else. A private read flag is not audited and carries no state a client did not
 * just send, so echoing the thread back would only invite somebody to render it.
 */
export const SupportFlagsResponse = z
  .object({ ok: z.literal(true).describe("Always true. The write either happened or the request failed.") })
  .describe("The acknowledgement of one viewer's private flags.");
export type SupportFlagsResponse = z.output<typeof SupportFlagsResponse>;

/** `GET {base}/replies`. */
export const SupportRepliesResponse = z
  .object({ replies: z.array(SupportReplyView).describe("The catalog, ordered for the requested category.") })
  .describe("The canned reply catalog.");
export type SupportRepliesResponse = z.output<typeof SupportRepliesResponse>;
