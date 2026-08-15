// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { MAX_SUBMISSION_ATTACHMENTS, MAX_SUBMISSION_BODY_CHARS, MAX_SUBMISSION_SUBJECT_CHARS } from "../config/config";
import { SupportChannel, SupportPriority, SupportSentiment } from "../data/enums";
import { SupportSubmissionContext } from "../data/message";
import { MAX_PAGE_SIZE } from "../store/threads";

/**
 * The request contracts every support route declares (CLAUDE.md §HTTP).
 *
 * Every one of these is a **bound on something a caller chose**, which is the whole job: a control-
 * plane credential is verified, but verified is not the same as trusted, and a management client with
 * a bug can ask for a million rows as easily as a hostile one can.
 *
 * The category filter is a bounded string rather than an enum, and that is deliberate: the taxonomy
 * is federated, so the valid set is not known here — and building the schema from the configured set
 * would make a filter for a category an adopter just removed a 400 instead of an empty list, which is
 * a worse answer to the same question. The value is only ever compared, never interpreted.
 */

/** A thread id in the path. */
export const ThreadIdParam = z
  .object({
    id: z
      .string()
      .uuid()
      .describe("The thread's UUID. A param schema constrains the string; the handler still does the lookup."),
  })
  .describe("The path parameters of every single-thread route.");
export type ThreadIdParam = z.infer<typeof ThreadIdParam>;

/** A category key as a filter — bounded and shaped, never resolved against the configured set. */
const CategoryFilter = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe(
    "One category key from this project's effective taxonomy. A key an adopter removed simply matches nothing.",
  );

/** The inbox listing query. */
export const ListThreadsQuery = z
  .object({
    archived: z
      .enum(["true", "false"])
      .optional()
      .describe("`true` for the done pile, `false` or absent for the open inbox — which is the default on purpose."),
    category: CategoryFilter.optional().describe("Filter to one category — what the classifier made of it."),
    declaredCategory: CategoryFilter.optional().describe(
      "Filter to one category **the submitter chose**, which is a different question from `category` and answers it about different threads. Combining the two is how an operator finds the disagreements; asking for this one alone is how they triage a project with `ai.enabled: false`, where nothing ever writes the other.",
    ),
    priority: SupportPriority.optional().describe("Filter to one priority."),
    sentiment: SupportSentiment.optional().describe("Filter to one sentiment."),
    channel: SupportChannel.optional().describe(
      "Filter to one channel — `email` for mail, `app` for what signed-in users filed from inside the app. Absent shows both, which is the right default for an inbox that is one queue however things arrived.",
    ),
    inbox: z
      .string()
      .min(3)
      .max(256)
      .optional()
      .describe("Filter to one configured inbox address, for a Worker serving several."),
    q: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Free text over subjects and bodies. Keyword search — the words people actually remember."),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe("How many threads to return. Bounded, because a verified client can still have a bug."),
  })
  .describe("The inbox query: what to filter by, what to search for, and where to resume.");
export type ListThreadsQuery = z.infer<typeof ListThreadsQuery>;

/** The archive/unarchive body. */
export const ArchiveThreadInput = z
  .object({
    archived: z
      .boolean()
      .describe(
        "`true` marks the conversation done; `false` reopens it. Explicit rather than a toggle, so a retried request lands on the state the caller meant rather than flipping it back.",
      ),
  })
  .describe("Mark a conversation done, or reopen it.");
export type ArchiveThreadInput = z.infer<typeof ArchiveThreadInput>;

/** The reply body. */
export const ReplyInput = z
  .object({
    body: z
      .string()
      .min(1)
      .max(50_000)
      .describe(
        "The reply text, as a human wrote and edited it. Rendered HTML-escaped into the adopter's email shell — it is prose, never markup.",
      ),
    agentName: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("Who is answering, signed at the bottom. Omitted rather than guessed."),
  })
  .describe("An answer to send to the customer.");
export type ReplyInput = z.infer<typeof ReplyInput>;

/** The per-viewer flags body. */
export const FlagsInput = z
  .object({
    read: z.boolean().optional().describe("Mark read or unread. Absent leaves it alone."),
    snoozedUntil: z
      .string()
      .datetime()
      .nullish()
      .describe(
        "Hide this thread from your inbox until this ISO-8601 moment. `null` clears a snooze; absent leaves it alone. A time rather than a flag, so it expires on its own and nothing has to sweep.",
      ),
  })
  .describe("One viewer's private read and snooze state.");
export type FlagsInput = z.infer<typeof FlagsInput>;

/**
 * One file on an in-app submission.
 *
 * The bytes arrive base64-encoded in JSON so the whole request stays one Zod object on the route line,
 * like every other route in this capability. **The size and type bounds are not here**: they are the
 * adopter's `submission.attachments` config, resolved in the handler, because a request schema is built
 * once at module load and cannot know them. What this bounds is the shape — a filename that renders, a
 * MIME type that looks like one, and a payload that is base64 at all.
 */
export const SubmittedAttachmentInput = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "The filename as the client declares it. **Recorded and never honoured** — the R2 key is server-derived, so this is metadata a console renders escaped, not a path anything resolves.",
      ),
    contentType: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)
      .describe(
        "The MIME type as the client declares it, lowercased, checked against the configured allowlist in the handler. Never used to serve the bytes: every object is stored as `application/octet-stream`, because R2 echoes a stored type back on a presigned GET and a browser renders `text/html`.",
      ),
    data: z
      // **Both alphabets, and the union is not belt-and-braces.** `z.base64()` rejects any string
      // containing `-` or `_`, so it alone would 400 every client whose platform encoder emits
      // `base64url` — Swift's `base64EncodedString(options:)`, Node's `toString("base64url")`, and
      // most JWT-adjacent helpers — while `decodeBase64` sits behind it happily normalising the two.
      // A validator that refuses what the decoder documents as fine is the validator that is wrong.
      .union([z.base64(), z.base64url()])
      .describe(
        "The file's bytes, base64 — the standard alphabet or the URL-safe one, because a client whose encoder emits the latter has not made a mistake worth a 400. The configured `maxBytes` bound is measured on the **decoded** length, which is a third smaller than this string.",
      ),
  })
  .describe("One file attached to an in-app support request, as bytes a signed-in client encoded.");
export type SubmittedAttachmentInput = z.infer<typeof SubmittedAttachmentInput>;

/**
 * The in-app submission body.
 *
 * **Nothing here names an account, and nothing here could.** The submitter is `c.var.auth.userId`,
 * proved before this schema ran — a `userId` field would be a client-supplied identity on the one
 * surface whose whole argument is that it does not need one.
 *
 * The lengths are the hard ceilings from `config/config.ts`, not the adopter's configured bounds: this
 * schema is built once at module load, and the configured numbers are applied in the handler where the
 * resolved config lives. A body over the ceiling never reaches a handler at all.
 */
export const SubmitFeedbackInput = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(MAX_SUBMISSION_SUBJECT_CHARS)
      .describe("What the request is about. Becomes the thread's name in the inbox and the subject of every reply."),
    body: z
      .string()
      .min(1)
      .max(MAX_SUBMISSION_BODY_CHARS)
      .describe("The report itself, as the person wrote it. Plain text — it is prose, never markup."),
    declaredCategory: CategoryFilter.optional().describe(
      "What the person writing says this is about, from your app's own chooser. **Named for what it is, on the wire as well as in the row**: a field called `category` here would land in a column of that name that this never touches, which is the exact confusion the two columns exist to prevent. Bounded to a key's shape here and checked against your effective taxonomy in the handler — a key you do not declare is **refused**, because a chooser was built from that taxonomy and a value outside it is the client's bug. Accepted only when opening a request: sent alongside `threadId` it is refused rather than ignored.",
    ),
    threadId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Continue this conversation instead of opening one. Accepted only for the caller's **own** app thread; anybody else's answers 404, which is the same answer a thread that does not exist gets — a 403 would confirm the id names a real conversation.",
      ),
    context: SupportSubmissionContext.optional().describe(
      "What the app knows and the user did not type — screen, build, platform, environment, locale. A closed set: an undeclared key is refused rather than stored, so this cannot quietly become a telemetry pipe.",
    ),
    attachments: z
      .array(SubmittedAttachmentInput)
      .max(MAX_SUBMISSION_ATTACHMENTS)
      .default([])
      .describe(
        "Files attached to the request. Bounded by `submission.attachments` in the adopter's config — count, decoded size, and an allowlist of types — and refused as a whole rather than silently trimmed. The ceiling here is the one that holds whatever that config says, and it is checked before any payload is decoded.",
      ),
  })
  .describe("An in-app support request from a signed-in user: what it is about, what happened, and what it carries.");
export type SubmitFeedbackInput = z.infer<typeof SubmitFeedbackInput>;

/** The submitter's own thread list. */
export const MyThreadsQuery = z
  .object({
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("Where to resume, from the previous page's `nextCursor`. Opaque; a malformed one is a first page."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe("How many conversations to return. Bounded, because a signed-in caller can still have a bug."),
  })
  .describe(
    "The submitter's own conversation list. No filters: this is one person's handful of requests, not an inbox to triage.",
  );
export type MyThreadsQuery = z.infer<typeof MyThreadsQuery>;

/** The canned-reply catalog query. */
export const RepliesQuery = z
  .object({
    category: CategoryFilter.optional().describe(
      "Order the catalog for this category — its snippets first, then the general-purpose ones. Ordering, never filtering: a misclassified thread must not hide the snippet its operator actually needs.",
    ),
  })
  .describe("How to order the canned reply catalog.");
export type RepliesQuery = z.infer<typeof RepliesQuery>;
