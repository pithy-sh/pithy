// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { asRead } from "@pithy-sh/core/src/projection/asRead";
import { z } from "zod";
import {
  SupportAccountLinkSource,
  SupportChannel,
  SupportMessageDirection,
  SupportPriority,
  SupportSentiment,
} from "../data/enums";
import { SupportSubmissionContext } from "../data/message";
import { SUPPORT_BILLING_SCOPE } from "../link/sender";

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
    channel: SupportChannel.describe(
      "How this conversation started — `email` at an inbound address, or `app` from a signed-in user of the adopter's own app.",
    ),
    inboxAddress: z
      .string()
      .nullable()
      .describe(
        "The support address this thread arrived on, lowercased, and the address a reply comes back to. Null only on an `app` thread in a project with no inbound address configured.",
      ),
    subject: z.string().describe("The subject of the message that opened the thread. Later replies never rewrite it."),
    fromAddress: z.string().describe("The sender's address, lowercased."),
    fromName: z.string().nullable().describe("The sender's display name, or null. Untrusted text; render it escaped."),
    senderAuthenticated: z
      .boolean()
      .describe(
        "Whether the sender was proved to be who they claim. On `email` that means the `From:` header was proved, and false means unproven rather than forged — it is what withholds the customer link. Always true on `app`, where a session proved it before the request arrived.",
      ),
    userId: z.string().nullable().describe("The user this sender resolves to, or null when nobody or unproven."),
    accountLinkSource: SupportAccountLinkSource.nullable().describe(
      "How `userId` was established, or null when there is no link. **Render these differently.** `session` means an authenticated request proved it and the account *is* the caller; `email_address` means it was matched against an address in a header nobody proved. The same operator action — a refund, a reset — follows from very different evidence.",
    ),
    declaredCategory: z
      .string()
      .nullable()
      .describe(
        "**What the submitter said this is about**, or null when nobody said — every mail thread, and every app thread filed without a chooser. **Render this and `category` differently, and never fold one into the other.** They are two facts with two authors: this is a claim by the person writing, `category` is a machine's judgement about them, and an operator deciding what to do needs to know which is on screen. Where they disagree, that disagreement is the most useful thing on the row. Where `classifiedAt` is null this is the only category anybody stated.",
      ),
    category: z
      .string()
      .describe(
        "**What the classifier made of it** — the current category key, from this project's own federated taxonomy. `uncategorized` until a classification lands, and forever on a project with `ai.enabled: false`.",
      ),
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
    channel: SupportChannel.describe(
      "How this message travelled, which on an outbound row says how the answer was delivered: `email` means it went out, `app` means it is waiting for the submitter to read it and no mail was sent.",
    ),
    context: SupportSubmissionContext.nullable().describe(
      "The bounded context an app submission carried — screen, build, platform, environment, locale. Null on every mail-path message.",
    ),
    fromAddress: z
      .string()
      .nullable()
      .describe(
        "The address this message was sent from, lowercased. Null on an answer delivered in the app, which left no envelope.",
      ),
    fromName: z.string().nullable().describe("The sender's display name, or null. Untrusted text."),
    toAddress: z
      .string()
      .nullable()
      .describe("The address this message was addressed to, lowercased. Null on an app submission with no envelope."),
    subject: z.string().describe("This message's own subject, which may differ from the thread's."),
    textBody: z.string().describe("The plain-text body."),
    htmlBody: z
      .string()
      .nullable()
      .describe(
        "The sanitised HTML body, or null. Sanitised at ingest; the raw original stays in R2 and is never served.",
      ),
    emailJobId: z
      .string()
      .nullable()
      .describe(
        "The email job this message was enqueued as. Present exactly when `direction` is `outbound` and `channel` is `email`; read `channel` to ask whether an answer went out, never the absence of this.",
      ),
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
 * Which billing subject the purchase and entitlement lists cover — always `user`, and said out loud.
 *
 * `@pithy-sh/payments` keys a purchase on a **subject pair**, a user or an organization. Support starts
 * from a `From:` header and resolves a *person*; at thread-read time it holds no Hono `Context`, so it
 * cannot ask the adopter's subject seam which organization this caller is acting for. It therefore reads
 * `user`-subject rows and nothing else.
 *
 * **A field rather than a footnote, because empty already means too many things.** The purchase and
 * entitlement lookups are guarded dynamic imports whose `catch` returns `[]`, so an empty panel is
 * indistinguishable between "bought nothing", "`@pithy-sh/payments` is not installed" and "billed to an
 * organization this seam cannot see" — and an operator looking at a customer with a live subscription
 * reads it as the first. That is the actual hazard, and it is a wrong refund decision away from costing
 * something. Declaring the scope on the wire lets a console say *why* the panel is thin.
 *
 * **A closed literal, not a string.** Widening it is then a compile error at every consumer, which is
 * correct: the day support can resolve an organization, every panel has to decide what to render.
 */
export const SenderBillingScope = z
  .literal(SUPPORT_BILLING_SCOPE)
  .describe(
    "Which billing subject the purchase and entitlement lists cover. Always `user`: support resolves a person from an address and cannot reach the adopter's subject seam, so an organization-billed customer's purchases are not shown here.",
  );
export type SenderBillingScope = z.output<typeof SenderBillingScope>;

/**
 * What the app already knows about the sender. Derived at read time, so it is always current.
 *
 * **Everything but `authenticated` and `billingScope` is empty when the sender is unproven.** The whole
 * value of the panel is that an operator trusts it, so it must not be populated from an address anybody
 * could have written — that is what turns a spoofed message into support-driven account takeover. The
 * scope is declared either way: it describes what this seam *can* see, not what it found.
 */
export const SenderContextView = z
  .object({
    authenticated: z.boolean().describe("Whether the `From:` header was proved to belong to the sender."),
    userId: z.string().nullable().describe("The linked user id, or null when this address belongs to nobody."),
    name: z.string().optional().describe("The account's display name, when auth is composed and the sender is known."),
    emailVerified: z.boolean().optional().describe("Whether the account has verified this address."),
    billingScope: SenderBillingScope,
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

/**
 * `POST {base}/threads/:id/reply`.
 *
 * **A union on `channel`, not an object with an optional `jobId`.** A reply either left by mail or was
 * stored for the submitter to read in the app, and those are different promises about when somebody
 * sees the answer. An optional field is exactly what lets a console render "sent" over both of them,
 * so the two arms are structurally different and a client has to branch to read either one.
 */
export const SupportReplySentResponse = z
  .discriminatedUnion("channel", [
    z
      .object({
        channel: z.literal("email").describe("The reply was handed to the durable send path. It is on its way."),
        messageId: z.string().describe("The outbound message row this reply created."),
        jobId: z.string().describe("The email job it was enqueued as. The send itself is a Workflow's job."),
      })
      .describe("A reply that was queued for sending, by message and by mail job."),
    z
      .object({
        channel: z
          .literal("app")
          .describe(
            "The reply was stored, and no mail was sent. The submitter reads it next time they open the conversation — which means nobody has told them yet, and telling them is the application's call.",
          ),
        messageId: z.string().describe("The outbound message row this reply created."),
      })
      .describe("A reply that is waiting in the app. There is no mail job, because there was no send."),
  ])
  .describe("The reply that was filed, and which of the two ways it reaches the customer.");
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

/**
 * ## The reader's contracts, beside the producers above
 *
 * Everything above this line is stated for a Worker checking its own projection, and it is strict on
 * purpose: `SupportChannel` and `SupportAccountLinkSource` are what `inbound/` branches on and what D1
 * holds, and a tolerated-unknown member there would license this capability to *store* a channel it
 * cannot handle. Nothing below changes any of that. The enums are untouched, and so is every schema
 * above.
 *
 * Below is the same projection for the other consumer: a management client reading a Worker **it does
 * not control**. That client is crossing a trust boundary — a fork, a bug, a half-finished deploy, or a
 * hostile Worker each put a member here that no enum of ours declares — and under the strict schema one
 * such token costs it the entire response. It cost `pithy-sh/dashboard#15` exactly that: one
 * unrecognised `channel` and the support pane rendered zero of twenty-five conversations. The client
 * then had to widen our shape locally, which is the hand-held mirror `#113` exists to forbid.
 *
 * So the tolerance is published rather than reimplemented, by the one pattern
 * `@pithy-sh/core/src/projection/asRead` states for the whole kit: same objects, every enum read as a
 * string, every other field the identical schema instance.
 *
 * **What a client does with a widened value is ask the enum.** `SupportChannel.safeParse(value).success`
 * answers *does this capability declare it*, and a value it does not declare is **marked, never mapped**
 * — rendering an unknown provenance as the nearest one you know is a lie about evidence on the screen
 * where somebody decides whether to act on a stranger's request.
 *
 * **Only the management surface.** The submitter's own views stay strict: an app reading its own
 * Worker's `/feedback` is not reading a stranger, and `SupportReplySentResponse` is a union discriminated
 * on a literal the client itself sent, where tolerating an unknown arm would mean tolerating a response
 * with no shape at all.
 */

/** {@link SupportThreadView}, as a client that does not control the Worker must read it. */
export const SupportThreadViewAsRead = asRead(SupportThreadView);
export type SupportThreadViewAsRead = z.output<typeof SupportThreadViewAsRead>;

/** {@link SupportListedThreadView}, as a client that does not control the Worker must read it. */
export const SupportListedThreadViewAsRead = asRead(SupportListedThreadView);
export type SupportListedThreadViewAsRead = z.output<typeof SupportListedThreadViewAsRead>;

/** {@link SupportMessageView}, as a client that does not control the Worker must read it. */
export const SupportMessageViewAsRead = asRead(SupportMessageView);
export type SupportMessageViewAsRead = z.output<typeof SupportMessageViewAsRead>;

/** `GET {base}/threads`, as a client that does not control the Worker must read it. */
export const SupportThreadsResponseAsRead = asRead(SupportThreadsResponse);
export type SupportThreadsResponseAsRead = z.output<typeof SupportThreadsResponseAsRead>;

/** `GET {base}/threads/:id`, as a client that does not control the Worker must read it. */
export const SupportThreadResponseAsRead = asRead(SupportThreadResponse);
export type SupportThreadResponseAsRead = z.output<typeof SupportThreadResponseAsRead>;

/** `POST {base}/threads/:id/archive`, as a client that does not control the Worker must read it. */
export const SupportArchiveResponseAsRead = asRead(SupportArchiveResponse);
export type SupportArchiveResponseAsRead = z.output<typeof SupportArchiveResponseAsRead>;

/**
 * ## The submitter's own view, and what it deliberately omits
 *
 * Everything above this line is written for a **management client**: an operator triaging an inbox,
 * who needs the classification to sort by and the sender's purchase history to act on. Everything
 * below is written for the **person who wrote the message**, and it is a different object rather than
 * the same one with fields nulled — because a projection that starts from the operator's shape leaks
 * the first time somebody adds a column and forgets which of the two callers is reading.
 *
 * A submitter is shown their own words, the answers to them, and whether the thread is done. They are
 * never shown the classification (a machine's judgement about them, and a filter on it is the inbox's
 * business), the priority or sentiment (the same, and `angry` rendered back to the person it describes
 * is its own kind of disaster), the per-viewer flags (private to an operator), the account link or its
 * provenance (they know who they are), or anything at all about another account.
 */

/** One of the submitter's own conversations. */
export const SupportMyThreadView = z
  .object({
    id: z.string().describe("The conversation's id — what the read-back and a follow-up submission take."),
    subject: z.string().describe("What they called it when they opened it. Later messages never rewrite it."),
    resolved: z
      .boolean()
      .describe(
        "Whether support has marked this done. Named for the reader rather than mirroring the column: `archived` is an inbox's word for a thread it has finished with, and to the person waiting on an answer the fact is that it was resolved. Writing again reopens it.",
      ),
    messageCount: z.number().int().describe("How many messages the conversation holds, theirs and the answers."),
    lastMessageAt: z.iso.datetime().describe("When the conversation last moved, ISO-8601. The list sorts on this."),
    createdAt: z.iso.datetime().describe("When they opened it, ISO-8601."),
  })
  .describe("One of the caller's own in-app support conversations, as the person who opened it sees it.");
export type SupportMyThreadView = z.output<typeof SupportMyThreadView>;

/** One message in the submitter's own conversation. */
export const SupportMyMessageView = z
  .object({
    id: z.string().describe("The message's id."),
    direction: SupportMessageDirection.describe(
      "`inbound` is theirs, `outbound` is the answer. The only identity on this view: who answered is a person's name in the body if they signed it, and never an operator's account.",
    ),
    body: z
      .string()
      .describe(
        "The message text. Plain text on both sides — what they sent, and what was sent back. Never HTML, so a client renders it escaped and there is nothing here to sanitise.",
      ),
    context: SupportSubmissionContext.nullable().describe(
      "The context their app attached to this message, so a client can show what was sent on their behalf. Null on an answer.",
    ),
    attachments: z.array(SupportAttachmentView).describe("What they attached to this message. Empty on an answer."),
    sentAt: z.iso.datetime().describe("When it was sent, ISO-8601."),
  })
  .describe("One message in the caller's own conversation — their words, or the answer to them.");
export type SupportMyMessageView = z.output<typeof SupportMyMessageView>;

/** `POST {base}/feedback`. */
export const SupportSubmissionResponse = z
  .object({
    threadId: z.string().describe("The conversation it landed in — a new one, or the one it continued."),
    messageId: z.string().describe("The message that was stored."),
    opened: z
      .boolean()
      .describe(
        "True when this opened a conversation, false when it continued one. A client that sent no `threadId` and gets false has hit nothing surprising — it cannot happen — so this is here for the client that sent one and wants to confirm which.",
      ),
    attachments: z
      .number()
      .int()
      .describe(
        "How many attachments were stored. Reported rather than assumed: a deployment with no bucket bound stores the report and none of its files, and a client that showed a paperclip should be able to say so.",
      ),
  })
  .describe("What an in-app support request produced.");
export type SupportSubmissionResponse = z.output<typeof SupportSubmissionResponse>;

/** `GET {base}/feedback`. */
export const SupportMyThreadsResponse = z
  .object({
    threads: z.array(SupportMyThreadView).describe("The caller's own conversations, newest first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the caller's own support conversations.");
export type SupportMyThreadsResponse = z.output<typeof SupportMyThreadsResponse>;

/** `GET {base}/feedback/:id`. */
export const SupportMyThreadResponse = z
  .object({
    thread: SupportMyThreadView.describe("The conversation."),
    messages: z.array(SupportMyMessageView).describe("Its messages, oldest first — a conversation reads downward."),
  })
  .describe("One of the caller's own conversations, in full.");
export type SupportMyThreadResponse = z.output<typeof SupportMyThreadResponse>;

/** `GET {base}/replies`. */
export const SupportRepliesResponse = z
  .object({ replies: z.array(SupportReplyView).describe("The catalog, ordered for the requested category.") })
  .describe("The canned reply catalog.");
export type SupportRepliesResponse = z.output<typeof SupportRepliesResponse>;
