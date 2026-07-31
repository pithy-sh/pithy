// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SupportPriority, SupportSentiment } from "../data/enums";
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
    category: CategoryFilter.optional().describe("Filter to one category."),
    priority: SupportPriority.optional().describe("Filter to one priority."),
    sentiment: SupportSentiment.optional().describe("Filter to one sentiment."),
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

/** The canned-reply catalog query. */
export const RepliesQuery = z
  .object({
    category: CategoryFilter.optional().describe(
      "Order the catalog for this category — its snippets first, then the general-purpose ones. Ordering, never filtering: a misclassified thread must not hide the snippet its operator actually needs.",
    ),
  })
  .describe("How to order the canned reply catalog.");
export type RepliesQuery = z.infer<typeof RepliesQuery>;
