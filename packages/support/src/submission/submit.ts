// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { chunkRowsByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { attachmentKey, putAttachment, sha256Hex } from "../attachment/store";
import { SupportAuditActions } from "../audit/actions";
import type { SupportConfig } from "../config/config";
import { SupportAttachment } from "../data/attachment";
import { categoryEnum, type SupportCategories } from "../data/categories";
import { SupportMessage, type SupportSubmissionContext } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
} from "../data/tables";
import { SupportThread, UNCLASSIFIED } from "../data/thread";
import { SupportInvalidCategoryError, SupportNotFoundError, SupportRejectedError } from "../error/errors";
import { safeFilename } from "../mime/parse";
import { indexMessage } from "../store/search";
import { checkAccountRate, checkAttachment } from "./guard";

/**
 * The in-app submission path — a signed-in user opening a support thread from inside the app, without
 * leaving it for their mail client.
 *
 * This is `inbound/ingest.ts` for the other channel, and it is deliberately the *same* destination:
 * one threads table, one messages table, one classifier, one taxonomy, one console. A second package
 * would have been a second inbox and a support person with two of them, neither holding the whole
 * conversation — and the reply to an in-app report goes out by email regardless, because that is where
 * the person will read it.
 *
 * ## What this path does not have to do
 *
 * `inbound/authenticity.ts` is two hundred lines earning the right to say a thread belongs to a
 * customer, because a `From:` header is an unauthenticated claim and decorating a spoofed thread with a
 * real customer's billing history is the opening move of support-driven account takeover.
 *
 * **There is no `From:` here to spoof.** `requireAuth()` proved the session before the handler ran, so
 * the account arrives already established — and the thread records that with `accountLinkSource:
 * "session"`, so a console can tell a link that *is* the identity from one that was matched against a
 * header. Nothing in the submitted payload names an account, and nothing here reads one from it.
 *
 * ## The order of operations
 *
 * The mail path's rule, applied to a different shape: **refuse on the cheapest true reason first.**
 * The two shape bounds a client controls the cost of — how many files, and how large each encoded one
 * is — are applied at the transport boundary in `http/handlers.ts` *before* anything is decoded,
 * because `atob` materialises its whole result and a size check after it has already been handed the
 * allocation it meant to refuse. What is left arrives here as bytes:
 *
 * 0. **The declared category**, which needs no I/O at all — it is a comparison against a taxonomy this
 *    process already holds, so it is genuinely the cheapest true reason there is.
 * 1. **The account**, because everything else depends on the address a reply will come back to, and a
 *    report nobody can answer is not worth storing.
 * 2. **The rate bound**, before anything is written.
 * 3. **The attachments**, every one checked before one is written, so a refusal never leaves half a
 *    submission's files in the bucket.
 * 4. **Store**, which must not fail.
 * 5. **Dispatch classification**, which is allowed to fail — the same rule the mail path follows, and
 *    for the same reason: a model that is briefly down must never take somebody's report with it.
 *
 * The count bound is checked in both places on purpose. The handler's is what keeps the decode
 * bounded; this one is what keeps the bound true for any caller that reaches this function directly,
 * which is every test and every future transport.
 */

/** What a submission produced. */
export interface SubmitOutcome {
  /** The thread it landed in — new, or the one it continued. */
  threadId: string;
  /** The message row it created. */
  messageId: string;
  /** Whether it opened a thread rather than continuing one. */
  newThread: boolean;
  /** How many attachments were stored. */
  attachments: number;
  /** Whether a classification was dispatched. */
  classifying: boolean;
}

/** One file a submitter attached, already decoded. */
export interface SubmittedAttachment {
  /** The filename as the client declared it. Untrusted; recorded, never honored. */
  filename: string;
  /** The MIME type as the client declared it, checked against the configured allowlist. */
  contentType: string;
  /** The bytes themselves. */
  bytes: Uint8Array;
}

/** Everything a submission needs, all injectable — nothing below this reads a binding. */
export interface SubmitDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The resolved config. */
  config: SupportConfig;
  /**
   * The effective taxonomy — the shipped defaults plus the adopter's, already merged.
   *
   * Taken as a dep rather than re-derived from `config.categories` here, because two resolutions of one
   * taxonomy are two things free to disagree: the classifier parses against the capability's merged
   * set, and a submitted claim validated against a differently-merged one would be accepted or refused
   * on a vocabulary nothing else in the process uses.
   */
  categories: SupportCategories;
  /** The R2 bucket attachments are written to. Absent means none are stored. */
  bucket?: R2Bucket;
  /** Whether the FTS5 index is composed. */
  fts: boolean;
  /**
   * The submitter's account, by id. Returns null when `@pithy-sh/auth` is absent or the row is gone —
   * both of which contradict the session that got here, so the caller treats it as a fault rather than
   * as a supported state.
   */
  resolveAccount: (userId: string) => Promise<{ email: string; name?: string } | null>;
  /** Start a classification for a stored message. Allowed to fail and allowed to decline. */
  dispatchClassify: (messageId: string) => Promise<boolean>;
  /** The audit seam. */
  emit: AuditEmit;
  /** The request logger. */
  log: Logger;
  /** Generate a row id. */
  newId: () => string;
  /** Now. */
  now: () => Date;
}

/** What the submitter sent, with the identity taken from the session rather than from the payload. */
export interface SubmitInput {
  /** The authenticated user id. **From `c.var.auth`, never from the body.** */
  userId: string;
  /** What the report is about. Becomes the thread's name, and the subject of every reply on it. */
  subject: string;
  /** The report itself, as the person wrote it. */
  body: string;
  /**
   * What the submitter says this is about, from the app's own chooser. Their claim, not a
   * classification — validated against the effective taxonomy, stored on the thread it opens, and never
   * read by the classifier. Absent when the client offers no chooser, which stays the ordinary case.
   *
   * Accepted only on a submission that **opens** a thread; sending it with `threadId` is refused rather
   * than ignored (see {@link checkDeclaredCategory}).
   */
  declaredCategory?: string;
  /** Continue this thread instead of opening one. Refused unless it is this account's own app thread. */
  threadId?: string;
  /** The bounded context the app supplied. */
  context?: SupportSubmissionContext;
  /** The files attached, already decoded. */
  attachments: readonly SubmittedAttachment[];
}

/** Record a refusal. Never throws — a guard decision must not become a 500 on top of a 429. */
async function auditRejection(deps: SubmitDeps, reason: string, detail: string, userId: string): Promise<void> {
  try {
    await deps.emit({
      action: SupportAuditActions.submissionRejected,
      outcome: "denied",
      severity: "warning",
      // `user`, and the id is populated — the opposite of the mail path, where the actor is anonymous
      // because a `From:` header is a claim. Here the session proved it, so naming the account is
      // recording a fact rather than repeating an assertion, and it is the whole operational value of
      // the event: an adopter acts on the account, and cannot without knowing which.
      actorType: "user",
      actorId: userId,
      resourceType: "support_inbox",
      metadata: { reason, channel: "app" },
    });
    deps.log.warn("support submission refused", { reason, detail, userId });
  } catch (error) {
    deps.log.warn("support submission rejection audit dropped", { reason, detail, error });
  }
}

/**
 * Resolve the thread a submission continues.
 *
 * **Both conditions, and a 404 rather than a 403 when either fails.** The thread must be this
 * account's and it must be an app thread: a 403 would confirm that the id names a real conversation,
 * which on an inbox of other people's correspondence is the disclosure the check exists to prevent —
 * so an id belonging to somebody else is indistinguishable from one belonging to nobody.
 *
 * An `email` thread is excluded even when it carries this account's `userId`, and that exclusion is
 * the point rather than an oversight: that link was matched from an address in a header nobody proved,
 * so treating it as ownership would let whoever currently holds an address read a conversation that
 * merely *claims* to be theirs.
 */
async function resolveOwnThread(db: SupportDatabase, threadId: string, userId: string): Promise<{ id: string }> {
  const thread = await db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .select(["id"])
    .where("id", "=", threadId)
    .where("userId", "=", userId)
    .where("channel", "=", "app")
    .executeTakeFirst();
  if (!thread) throw new SupportNotFoundError({ detail: `no app thread ${threadId} owned by ${userId}` });
  return thread;
}

/**
 * Check a submitter's declared category, before anything else and before any I/O.
 *
 * **An undeclared key is refused, never stored and never downgraded.** Storing it would make
 * `declared_category` a client-writable vocabulary: one client shipping `Billing` or `billng` and the
 * console's filter silently misses those threads forever, while the inbox grows a long tail of one-off
 * keys nobody declared. Downgrading to `uncategorized` is the worse of the two remaining options,
 * because it makes a broken chooser indistinguishable from a submitter who genuinely chose nothing —
 * the exact collapse this column exists to prevent, arrived at from the other side.
 *
 * It is refused rather than tolerated **because the writer can be fixed.** `classifyMessage` falls back
 * to `uncategorized` on a label the model invented, and that is right there: a model cannot be told it
 * was wrong at the call site. A client can, and a 400 is how it gets told — the chooser was built from
 * a taxonomy the adopter declared, so a value outside it is that client's bug and should be loud.
 *
 * **A category may not ride along with a `threadId`.** A thread already carries what it was filed
 * under, and a second, later claim has no honest meaning: ignoring it is a chooser that does nothing —
 * which is the whole defect this seam exists to close — and honoring it would let a follow-up rewrite
 * the premise a conversation was opened on, the way `subject` deliberately cannot. So it is refused,
 * loudly, and a chooser stays what it is: something offered on the form that opens a request.
 *
 * **Nothing the submitter wrote reaches `message`.** The offending value goes in `detail`, which the
 * HTTP codec strips — this capability's whole input is text somebody else chose, and an error that
 * echoed it back would make the error channel a reflection surface.
 */
function checkDeclaredCategory(deps: SubmitDeps, input: SubmitInput): void {
  const declared = input.declaredCategory;
  if (declared === undefined) return;

  if (input.threadId !== undefined) {
    throw new ValidationError({
      message: "A category is chosen when a request is opened, not on a later message.",
      action: "Send the category with the first message, or leave it off to continue the conversation.",
      detail: `submission declared a category alongside threadId ${input.threadId}`,
    });
  }

  // The same schema `classifyMessage` parses a model's answer against, over the same effective
  // taxonomy — one definition of "a category this project has", checked at both boundaries. `safeParse`
  // rather than `parse`: a refusal here is a 400 this function shapes, never a `ZodError` escaping into
  // somebody else's handler.
  if (!categoryEnum(deps.categories).safeParse(declared).success) {
    throw new SupportInvalidCategoryError({
      message: "That is not a category this app offers.",
      action: "Choose one of the categories the app declares, or send the request without one.",
      detail: `submitted category ${JSON.stringify(declared)} is not in the effective taxonomy (${Object.keys(deps.categories).join(", ")})`,
    });
  }
}

/** How many columns one `pithy_support_attachments` row binds — derived, so a new column re-chunks. */
const SUPPORT_ATTACHMENT_COLUMNS = Object.keys(SupportAttachment.shape).length;

/**
 * Check every attachment before one byte is written.
 *
 * All-or-nothing, and refused rather than skipped — the opposite of the mail path, and the difference
 * is who is on the other end. An oversize part of an email is dropped because the sender is gone and
 * the message is still worth keeping; a submitter is right there, holding the screenshot that is the
 * most valuable thing the report carries, and silently storing the report without it means the first
 * reply asks for a file they believed they had already sent.
 */
function checkAttachments(deps: SubmitDeps, attachments: readonly SubmittedAttachment[]): void {
  const bounds = deps.config.submission.attachments;
  if (attachments.length === 0) return;

  if (!bounds.enabled) {
    throw new ValidationError({
      message: "This app does not accept attachments on a support request.",
      action: "Send the report without a file, and describe what you would have attached.",
      detail: "submission.attachments.enabled is false",
    });
  }
  if (attachments.length > bounds.maxCount) {
    throw new ValidationError({
      message: `A support request may carry at most ${bounds.maxCount} attachments.`,
      action: `Send at most ${bounds.maxCount} files.`,
      detail: `submission declared ${attachments.length} attachments, over the ${bounds.maxCount} bound`,
    });
  }
  for (const attachment of attachments) {
    const verdict = checkAttachment(deps.config.submission, {
      contentType: attachment.contentType,
      bytes: attachment.bytes.byteLength,
    });
    if (verdict.accepted) continue;
    throw new ValidationError({
      message:
        verdict.reason === "attachment_too_large"
          ? `An attachment may be at most ${bounds.maxBytes} bytes.`
          : "That kind of file cannot be attached to a support request.",
      action:
        verdict.reason === "attachment_too_large"
          ? "Attach a smaller file."
          : `Attach one of: ${bounds.allowedContentTypes.join(", ")}.`,
      detail: verdict.detail,
    });
  }
}

/** Store the checked attachments. Returns how many rows were written. */
async function storeAttachments(
  deps: SubmitDeps,
  attachments: readonly SubmittedAttachment[],
  threadId: string,
  messageId: string,
  now: Date,
): Promise<number> {
  const bucket = deps.bucket;
  if (attachments.length === 0) return 0;
  if (!bucket) {
    // Checked here rather than at the top, so a submission with no files still works on a deployment
    // that never provisioned a bucket — which is every project that turned attachments off.
    deps.log.warn("support submission attachments dropped — no bucket bound", { threadId, messageId });
    return 0;
  }

  const rows: SupportAttachment[] = [];
  for (const attachment of attachments) {
    const id = deps.newId();
    const key = attachmentKey(threadId, id);
    await putAttachment(bucket, key, attachment.bytes);
    rows.push({
      id,
      messageId,
      threadId,
      // The same sanitizer the mail path runs, and not optional here: `SupportAttachment.filename`
      // states the column holds a name "after stripping path separators and control characters", and
      // two producers of one column must guarantee the same thing about it. This channel is the more
      // attacker-friendly of the two for it — a MIME filename has to survive header encoding, while
      // this one is a JSON string a signed-in client picks byte for byte — so a bidi override that
      // renders `shot<U+202E>gnp.exe` as `shot.png`, or a name a console might put in a
      // `Content-Disposition`, arrives here intact unless something takes it out.
      filename: safeFilename(attachment.filename),
      contentType: attachment.contentType,
      size: attachment.bytes.byteLength,
      sha256: await sha256Hex(attachment.bytes),
      storageKey: key,
      contentId: null,
      // Nothing arriving this way is inline: there is no HTML body referencing it by `cid:`, which is
      // the only thing `inline` means.
      inline: false,
      createdAt: now,
    });
  }

  const encoded = rows.map((row) => SupportAttachment.encode(row));
  for (const chunk of chunkRowsByBoundParameters(encoded, SUPPORT_ATTACHMENT_COLUMNS)) {
    await deps.db.insertInto(SUPPORT_ATTACHMENTS_TABLE).values(chunk).execute();
  }
  return rows.length;
}

/**
 * Mint an RFC 5322 message id for a submission.
 *
 * **Without this the conversation forks the first time the customer answers.** A reply to an app thread
 * leaves by email carrying `In-Reply-To`, the customer's client puts that id in its `References`, and
 * `parentCandidates` looks it up in `pithy_support_messages` — so a submission stored with no id of its
 * own is a thread whose every answer opens a new one. The whole reason `mime/threading.ts` refuses to
 * match on subject is that fragmented conversations are the failure mode worth engineering against.
 *
 * The domain comes from the inbox address, because that is the domain the reply will actually leave
 * from; with no address configured there is no reply and therefore nothing to thread.
 */
export function submissionMessageId(messageId: string, inboxAddress: string | null | undefined): string | null {
  const domain = inboxAddress?.split("@")[1];
  return domain ? `${messageId}@${domain}` : null;
}

/** Take one in-app submission. */
export async function submitFeedback(deps: SubmitDeps, input: SubmitInput): Promise<SubmitOutcome> {
  const now = deps.now();

  // 0. The declared category, first because it costs nothing: no query, no decode, no allocation the
  // caller chose the size of. Checked here rather than only at the transport boundary for the reason
  // the attachment count is — the bound has to hold for every caller that reaches this function
  // directly, which is every test and every future transport.
  checkDeclaredCategory(deps, input);

  // 1. The account. A session proved this id, so failing to read it is a fault in this deployment
  // rather than a supported state — `@pithy-sh/auth` composed is what made the session exist.
  const account = await deps.resolveAccount(input.userId);
  if (!account) {
    throw new InternalError({
      message: "Your account could not be read.",
      action: "Retry, and contact support by email if it keeps happening.",
      detail: `no pithy_auth_users row for authenticated user ${input.userId} — is @pithy-sh/auth composed on this Worker?`,
    });
  }

  // 2. The rate bound, before anything is decoded or written.
  const rate = await checkAccountRate(deps.db, deps.config.submission, { userId: input.userId, now });
  if (!rate.accepted) {
    await auditRejection(deps, rate.reason, rate.detail, input.userId);
    throw new SupportRejectedError({
      message: "You have sent too many support requests recently.",
      action: "Wait an hour and try again, or reply to the email on an existing request.",
      detail: rate.detail,
    });
  }

  // 3. Every attachment, before one is written.
  checkAttachments(deps, input.attachments);

  // 4. The thread — this account's own, or a new one. The ownership check is the read-back rule
  // applied to a write, and it raises the same 404 for somebody else's thread as for no thread.
  const existing = input.threadId ? await resolveOwnThread(deps.db, input.threadId, input.userId) : undefined;
  const threadId = existing?.id ?? deps.newId();
  const newThread = existing === undefined;
  const messageId = deps.newId();

  // The address a reply comes back to, and the only meaning `inboxAddress` has on an app thread. Null
  // is supported: a project can collect in-app feedback with no mail configured at all.
  const inbox = deps.config.reply.replyToAddress ?? deps.config.inboundAddresses[0] ?? null;

  const message: SupportMessage = {
    id: messageId,
    threadId,
    direction: "inbound",
    channel: "app",
    submittedByUserId: input.userId,
    context: input.context ?? null,
    mimeMessageId: submissionMessageId(messageId, inbox),
    mimeInReplyTo: null,
    mimeReferences: null,
    fromAddress: account.email,
    fromName: account.name ?? null,
    toAddress: inbox,
    subject: input.subject,
    textBody: input.body,
    // Nothing a submitter typed is ever stored as HTML. The mail path has an HTML body because mail
    // arrives as one and the raw form is kept; a submission is plain text the client sent, and
    // rendering it as markup in a console would be inventing an injection surface that has no source.
    htmlBody: null,
    emailJobId: null,
    // No raw form to keep: unlike a MIME message, what arrived *is* the parsed shape.
    rawKey: null,
    rawBytes: null,
    receivedAt: now,
    createdAt: now,
  };

  // 5. Message first, then the thread — the same order `ingest.ts` uses, with the same compensation.
  // A committed message with no thread is unrecoverable and invisible to every read path, so the
  // message is removed if the thread write fails.
  await deps.db.insertInto(SUPPORT_MESSAGES_TABLE).values(SupportMessage.encode(message)).execute();
  try {
    if (newThread) {
      const thread: SupportThread = {
        id: threadId,
        channel: "app",
        inboxAddress: inbox,
        subject: input.subject,
        fromAddress: account.email,
        fromName: account.name ?? null,
        // True, and for a stronger reason than any email thread can reach: there was no header to
        // prove, because the session was proved before the request arrived here.
        senderAuthenticated: true,
        userId: input.userId,
        accountLinkSource: "session",
        // The submitter's claim, set once and never rewritten. **Beside the spread rather than inside
        // it**: `UNCLASSIFIED` is the set of columns the classifier owns and overwrites on every run,
        // and a claim listed among them would be gone the first time a model looked at this thread.
        declaredCategory: input.declaredCategory ?? null,
        ...UNCLASSIFIED,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 1,
        firstMessageAt: now,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await deps.db.insertInto(SUPPORT_THREADS_TABLE).values(SupportThread.encode(thread)).execute();
    } else {
      await deps.db
        .updateTable(SUPPORT_THREADS_TABLE)
        .set((eb) => ({
          messageCount: eb("messageCount", "+", 1),
          lastMessageAt: now.getTime(),
          updatedAt: now.getTime(),
          // A customer writing again reopens a resolved thread, exactly as a reply by mail does.
          // Somebody wrote back and nobody saw it is the one failure a support inbox cannot have.
          archived: 0,
          archivedAt: null,
          archivedBy: null,
        }))
        .where("id", "=", threadId)
        .execute();
    }
  } catch (error) {
    await deps.db
      .deleteFrom(SUPPORT_MESSAGES_TABLE)
      .where("id", "=", messageId)
      .execute()
      .catch(() => {
        deps.log.error("support submission orphaned — thread write failed and the message could not be removed", {
          messageId,
          threadId,
        });
      });
    throw error;
  }

  if (deps.fts) {
    try {
      await indexMessage(deps.db, { threadId, messageId, subject: input.subject, body: input.body });
    } catch (error) {
      deps.log.warn("support submission not indexed", { messageId, error });
    }
  }

  // Best-effort, like the mail path: a bucket that is briefly unavailable costs the attachments, never
  // the report. The bytes were already checked, so nothing unbounded reaches R2 on this line.
  let attachments = 0;
  try {
    attachments = await storeAttachments(deps, input.attachments, threadId, messageId, now);
  } catch (error) {
    deps.log.warn("support submission attachments not stored", { messageId, error });
  }

  // 6. Classification, last and allowed to fail — the same classifier, the same federated taxonomy.
  const classifying = deps.config.ai.enabled;
  if (classifying) {
    try {
      await deps.dispatchClassify(messageId);
    } catch (error) {
      deps.log.warn("support submission classification dispatch failed", { messageId, error });
    }
  }

  return { threadId, messageId, newThread, attachments, classifying };
}
