// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SupportChannel, SupportMessageDirection } from "./enums";

/**
 * What the app knows about the moment a report was written, and the user did not have to type.
 *
 * A bug report without the screen, the build, and the environment is a round trip — the first reply is
 * always "which version, and where were you?". The app already holds all three, so asking a human to
 * retype them is the kind of friction this channel exists to remove.
 *
 * **It is a closed object, and unknown keys are refused rather than stripped.** This is a capability,
 * not a telemetry pipe: the risk of an open bag is that an adopter passes their whole client state
 * through it and quietly lands a customer's data in a support inbox that a console renders and an
 * operator reads. A closed set means a field that is not here cannot be posted by accident, and a
 * refusal says so at the boundary rather than silently dropping what somebody believed they sent.
 * Every field is bounded, because every one of them is a string a client chose.
 */
export const SupportSubmissionContext = z
  .object({
    screen: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Where in the app they were — a route, a screen name, whatever the app calls it. The single most useful field, because it turns 'the button does nothing' into a place to look.",
      ),
    appVersion: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "The build the report came from. Answers 'is this already fixed' without a round trip, which is the whole reason a bug report asks for it.",
      ),
    platform: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "The client the app is running as — `ios`, `android`, `web`, or whatever the adopter's own build calls itself. Free text rather than an enum: the set of clients is the adopter's, not this capability's.",
      ),
    environment: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "Which environment the client was pointed at. A report from staging read as production is a bug hunted in the wrong database, and the client is the only thing that knows.",
      ),
    locale: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "The locale the app was rendering in. Carried because a whole class of reports — a date a day out, a currency in the wrong place, text that overflows — is only reproducible in the reporter's locale.",
      ),
  })
  .strict()
  .describe(
    "The bounded context an app supplies with a submission, so a bug report arrives with the facts its first reply would otherwise have to ask for.",
  );
export type SupportSubmissionContext = z.output<typeof SupportSubmissionContext>;

/** The `References` header, split into ids. A JSON column so the chain stays a list rather than a string to re-split. */
export const SupportReferenceIds = z
  .array(z.string().describe("One RFC 5322 message id from the `References` chain, without its angle brackets."))
  .describe("The `References` chain, oldest first — the thread's ancestry as the sender's mail client recorded it.");
export type SupportReferenceIds = z.output<typeof SupportReferenceIds>;

/**
 * One message in `pithy_support_messages` — inbound mail as it arrived, or a reply as it went out.
 *
 * **The raw MIME is kept immutable in R2 and never rewritten.** `textBody`/`htmlBody` are a derived,
 * sanitized rendering of it, so a parser bug, a sanitizer change, or a reclassification pass can all
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
    direction: SupportMessageDirection.describe("Which way this message traveled."),
    channel: SupportChannel.describe(
      "How this message traveled, which on an outbound row is **how the answer was delivered**: `email` means it was handed to `@pithy-sh/email`'s durable send path, `app` means it was stored for the submitter to read in the app and no mail was sent. Per message rather than only per thread, because the two genuinely differ — one `app` thread can hold an answer that was mailed and an answer that was not, and those are different promises about when somebody will read them.",
    ),
    submittedByUserId: z
      .string()
      .nullish()
      .describe(
        "The authenticated `pithy_auth_users.id` that posted this message from inside the app. Null on every mail-path message and on every outbound reply. Taken from the request's session and **never** from anything the client sent — it is the identity, so it is also what the per-account submission bound counts.",
      ),
    context: sqliteJson(SupportSubmissionContext)
      .nullish()
      .describe(
        "The bounded context the app supplied — screen, build, platform, environment, locale. Null on every mail-path message, and on an app submission that declared none.",
      ),
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
    fromAddress: z
      .string()
      .nullish()
      .describe(
        "The address this message was sent from, lowercased. **Null exactly on an answer delivered in the app**, which left no envelope — there is no address a reply that was never mailed came from, and putting the deployment's own address there would claim a send that did not happen. Never null on anything that traveled by mail, and never present on anything that did not. Checked on the object, both ways, so it is a rule rather than a note.",
      ),
    fromName: z.string().nullish().describe("The sender's display name. Untrusted text; render it escaped."),
    toAddress: z
      .string()
      .nullish()
      .describe(
        "The address this message was addressed to, lowercased. **Null on an app submission to a project with no inbound address configured** — there was no envelope, and inventing one would put a string nothing can deliver to into the column the idempotency index keys on. Never null on a mail-path message.",
      ),
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
        "The HTML body **after sanitization** — scripts, event handlers, styles, frames, and remote-loading attributes removed. Null when the message carried no HTML. The raw original is still in R2 if the sanitizer ever needs re-running.",
      ),
    emailJobId: z
      .string()
      .nullish()
      .describe(
        "The `pithy_email_jobs.id` this message was enqueued as. **Present exactly when `direction` is `outbound` and `channel` is `email`**, and null everywhere else — it is the join to the job, never the way to ask whether an answer went out. That question is `channel`'s, because a null here would otherwise mean both 'this arrived' and 'this was delivered in the app', and a client would have to consult `direction` to tell them apart. It is the *job* id rather than the sent `Message-ID` deliberately: Cloudflare assigns the real id at send time and never tells the enqueuer, so a column claiming to hold it would be null exactly when somebody needed it.",
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
  .describe("One message in `pithy_support_messages` — the derived rendering of mail whose raw form lives in R2.")
  // **The invariant, stated once, where every producer already passes.** `emailJobId` is the join to
  // `pithy_email_jobs` and nothing else: it is present exactly when this message traveled by mail on
  // the way out. Written at a call site instead, this rule would hold until the second writer — and
  // there are already five (ingest, submission, the reply path, the seeds, the tests). Enforced here
  // it also runs on the way *back* out of D1, so a row that reached the table by any other route
  // cannot be handed to a projection that would render it as sent.
  .check((ctx) => {
    const row = ctx.value;
    const mailed = row.direction === "outbound" && row.channel === "email";
    const hasJob = row.emailJobId !== null && row.emailJobId !== undefined;
    if (hasJob === mailed) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["emailJobId"],
      message: mailed
        ? "An outbound `email` message must carry the `emailJobId` it was enqueued as. The row is written after the enqueue is accepted, so one without a job id is a reply nothing was ever asked to send."
        : "Only an outbound `email` message carries an `emailJobId`. An answer delivered in the app was never enqueued, and an inbound message was never sent — a job id on either makes the column mean something other than the job it names.",
    });
  })
  // **The second invariant, enforced the way the first one is.** `fromAddress` was loosened to nullable
  // for one row — the answer `sendReply` stores in the app, which has no envelope — and the rule that
  // bounds that was written as prose on the field. Prose holds until the second writer, which is the
  // argument the check above is made of; there is no reason it carries less weight here. A null on a
  // message that traveled by mail is a thread nobody can answer, because `sendReply` addresses the
  // reply to it. An address on one that did not travel claims a send that never happened, to every
  // projection that renders the column.
  .check((ctx) => {
    const row = ctx.value;
    const inApp = row.direction === "outbound" && row.channel === "app";
    const hasAddress = row.fromAddress !== null && row.fromAddress !== undefined;
    if (hasAddress === !inApp) return;
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["fromAddress"],
      message: inApp
        ? "An answer delivered in the app has no `fromAddress`. It left no envelope, so an address there names a send that did not happen."
        : "Everything but an answer delivered in the app carries the `fromAddress` it came from or went out as. Without one there is no address to reply to.",
    });
  });
export type SupportMessage = z.output<typeof SupportMessage>;
