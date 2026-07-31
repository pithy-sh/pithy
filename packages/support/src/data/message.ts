// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SupportMessageDirection } from "./enums";

/** The `References` header, split into ids. A JSON column so the chain stays a list rather than a string to re-split. */
export const SupportReferenceIds = z
  .array(z.string().describe("One RFC 5322 message id from the `References` chain, without its angle brackets."))
  .describe("The `References` chain, oldest first — the thread's ancestry as the sender's mail client recorded it.");
export type SupportReferenceIds = z.output<typeof SupportReferenceIds>;

/**
 * One message in `pithy_support_messages` — inbound mail as it arrived, or a reply as it went out.
 *
 * **The raw MIME is kept immutable in R2 and never rewritten.** `textBody`/`htmlBody` are a derived,
 * sanitised rendering of it, so a parser bug, a sanitiser change, or a reclassification pass can all
 * be re-run from the bytes that actually arrived. Storing only the parsed form would make the parse a
 * one-way decision taken at the worst possible moment — inside an `email()` handler with a CPU budget.
 *
 * `mimeMessageId` carries a **unique index**, and that is the idempotency anchor: Email Routing can
 * deliver the same message twice, and the second delivery must be a no-op rather than a duplicate.
 * SQLite permits repeated `NULL`s in a unique index, so a message that arrived without a `Message-ID`
 * (rare, and always a sign of something hand-rolled) still stores instead of colliding.
 */
export const SupportMessage = z
  .object({
    id: z.string().describe("UUID primary key for this message row — Pithy's id, not the sender's."),
    threadId: z.string().describe("The `pithy_support_threads.id` this message belongs to."),
    direction: SupportMessageDirection.describe("Which way this message travelled."),
    mimeMessageId: z
      .string()
      .nullish()
      .describe(
        "The RFC 5322 `Message-ID`, without angle brackets. Uniquely indexed, so a redelivered message is dropped rather than duplicated. Null when the sender omitted one.",
      ),
    mimeInReplyTo: z
      .string()
      .nullish()
      .describe(
        "The `In-Reply-To` id, without angle brackets — the direct parent. The first key threading tries, because it names exactly one message.",
      ),
    mimeReferences: sqliteJson(SupportReferenceIds)
      .nullish()
      .describe(
        "The `References` chain as a JSON column. Threading falls back to it when `In-Reply-To` names nothing we hold, which is what keeps a conversation together across a client that rewrites the subject.",
      ),
    fromAddress: z.string().describe("The sender's address, lowercased."),
    fromName: z.string().nullish().describe("The sender's display name. Untrusted text; render it escaped."),
    toAddress: z.string().describe("The address this message was addressed to, lowercased."),
    subject: z.string().describe("This message's own subject line, which may differ from the thread's."),
    textBody: z
      .string()
      .describe(
        "The plain-text body, or a text rendering of an HTML-only message. Always present, because the classifier reads this and a model should never be handed markup.",
      ),
    htmlBody: z
      .string()
      .nullish()
      .describe(
        "The HTML body **after sanitisation** — scripts, event handlers, styles, frames, and remote-loading attributes removed. Null when the message carried no HTML. The raw original is still in R2 if the sanitiser ever needs re-running.",
      ),
    emailJobId: z
      .string()
      .nullish()
      .describe(
        "The `pithy_email_jobs.id` an outbound reply was enqueued as, so a dashboard can show whether it actually sent. Null on every inbound message. It is the *job* id rather than the sent `Message-ID` deliberately: Cloudflare assigns the real id at send time and never tells the enqueuer, so a column claiming to hold it would be null exactly when somebody needed it.",
      ),
    rawKey: z
      .string()
      .nullish()
      .describe(
        "The R2 object key holding the immutable raw MIME. Null only when the bucket binding was absent at ingest, which is a degraded mode rather than a normal one.",
      ),
    rawBytes: z.number().int().nullish().describe("The raw message's size in bytes, as received."),
    receivedAt: SQLiteDate.describe(
      "When this Worker received the message — our clock, never the sender's `Date` header, which is attacker-controlled and would let anyone place themselves at the top of an inbox.",
    ),
    createdAt: SQLiteDate.describe("When the message row was written."),
  })
  .describe("One message in `pithy_support_messages` — the derived rendering of mail whose raw form lives in R2.");
export type SupportMessage = z.output<typeof SupportMessage>;
