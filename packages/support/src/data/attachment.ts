// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One attachment in `pithy_support_attachments` — the metadata row for bytes that live in R2.
 *
 * **The bytes are never proxied.** A dashboard gets a short-lived signed URL and fetches from R2
 * directly, because proxying would put a Pithy-operated surface in the data path, which is the exact
 * thing principle 1 exists to prevent. The key is server-derived and opaque, so holding a thread id
 * never lets a caller name or guess an object.
 *
 * `contentType` and `filename` are recorded **as the sender declared them** and are never trusted on
 * the way out. This is the most attacker-controlled field pair in the capability: a message can claim
 * `text/html` for a script, or a filename with a path separator or a right-to-left override in it.
 * Whatever serves these bytes re-derives its own `Content-Type` and `Content-Disposition`, the same
 * rule `@pithy-sh/storage` applies to uploads.
 */
export const SupportAttachment = z
  .object({
    id: z.string().describe("UUID primary key."),
    messageId: z.string().describe("The `pithy_support_messages.id` this attachment arrived on."),
    threadId: z
      .string()
      .describe(
        "The `pithy_support_threads.id`, denormalized from the message. Carried so the thread view lists every attachment in one indexed read instead of a join across the thread's messages.",
      ),
    filename: z
      .string()
      .describe(
        "The filename as the sender declared it, after stripping path separators and control characters. Display only — it never becomes part of a storage key.",
      ),
    contentType: z
      .string()
      .describe("The MIME type as the sender declared it. Recorded, never honoured — a serve path derives its own."),
    size: z
      .number()
      .int()
      .nonnegative()
      .describe("The attachment's size in bytes, measured from the decoded bytes rather than claimed."),
    sha256: z
      .string()
      .describe(
        "Lowercase hex SHA-256 of the decoded bytes. Makes a re-delivered attachment recognizable and gives an operator something to check a download against.",
      ),
    storageKey: z
      .string()
      .describe(
        "The R2 object key, server-derived and opaque (`support/<thread>/<uuid>`). Never sent to a client — a signed URL is.",
      ),
    contentId: z
      .string()
      .nullish()
      .describe(
        "The `Content-ID`, when the part carried one. What an inline image in the HTML body refers to by `cid:`.",
      ),
    inline: SQLiteBoolean.describe(
      "Whether the part was `Content-Disposition: inline` — a signature image rather than the document somebody meant to send. A dashboard hides these by default.",
    ),
    createdAt: SQLiteDate.describe("When the attachment row was written."),
  })
  .describe("One attachment in `pithy_support_attachments` — metadata for bytes stored in the adopter's own R2.");
export type SupportAttachment = z.output<typeof SupportAttachment>;
