// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { R2Bucket } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { chunkRowsByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { attachmentKey, putAttachment, rawMessageKey, sha256Hex } from "../attachment/store";
import { SupportAuditActions } from "../audit/actions";
import type { SupportConfig } from "../config/config";
import { SupportAttachment } from "../data/attachment";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
} from "../data/tables";
import { SupportThread, UNCLASSIFIED } from "../data/thread";
import { MAX_TEXT_BODY, type ParsedInboundMessage, parseInbound } from "../mime/parse";
import { htmlToText, sanitizeHtml } from "../mime/sanitize";
import { parentCandidates } from "../mime/threading";
import { truncateToBytes } from "../mime/truncate";
import { indexMessage } from "../store/search";
import { senderAuthenticity } from "./authenticity";
import { checkRates, checkSize } from "./guard";
import { resolveInbox } from "./recipient";

/**
 * Ingest — everything the `email()` handler does, with every dependency injected.
 *
 * The handler in `handler.ts` is a thin shell that reads bindings off `env` and calls this. That
 * split is what makes the interesting half testable: threading, idempotency, the guard's ordering,
 * and the attachment bounds are all exercised here against a real D1 and injected fakes, with no
 * Worker entry involved.
 *
 * ## The order of operations is the design
 *
 * Refusals are ordered by what they cost, and persistence comes before anything that can be slow or
 * unavailable:
 *
 * 1. **Size**, from the declared length, before parsing.
 * 2. **Parse**, then **is this ours** — decided on the SMTP envelope recipient, not on a header.
 * 3. **Rate**, which needs a database read and so goes after the free checks.
 * 4. **Idempotency**, because Email Routing can deliver twice and the second must be a no-op.
 * 5. **Store**, which must not fail.
 * 6. **Dispatch classification**, which is allowed to fail — a model that is slow or briefly down
 *    must never take the persistence of the message with it, which is the whole reason
 *    classification is a Workflow.
 *
 * A message that is not ours returns `{ handled: false }` and emits nothing. Every capability's
 * handler sees every message, so mail for the bounce handler passing through here is the normal
 * case, not an event.
 */

/** What ingest did. */
export type IngestOutcome =
  /** Not addressed to a configured inbox — another capability's mail, or nobody's. */
  | { handled: false; reason: "not_addressed" }
  /** Refused by the guard before anything was written. */
  | { handled: false; reason: "rejected"; rejection: string }
  /** Already stored under this `Message-ID`. A redelivery, and a no-op. */
  | { handled: true; duplicate: true; threadId: string; messageId: string }
  /** Stored. */
  | {
      handled: true;
      duplicate: false;
      threadId: string;
      messageId: string;
      /** Whether the message opened a new thread rather than continuing one. */
      newThread: boolean;
      /** How many attachments were stored, after the config bounds were applied. */
      attachments: number;
      /** Whether a classification was dispatched. False for auto-submitted mail and when AI is off. */
      classifying: boolean;
    };

/** Everything ingest needs, all injectable. */
export interface IngestDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The resolved config. */
  config: SupportConfig;
  /** The R2 bucket raw messages and attachments are written to. Absent means neither is kept. */
  bucket?: R2Bucket;
  /** Whether the FTS5 index is composed. False means search runs as a `LIKE` scan and nothing is indexed. */
  fts: boolean;
  /**
   * Start the classification Workflow for a stored message. Allowed to fail and allowed to decline —
   * an unprovisioned project has no binding, and a thread that stays `uncategorized` is a legitimate
   * state. The inbound path deliberately ignores the outcome; the reclassify route does not, because
   * it is answering a human.
   */
  dispatchClassify: (messageId: string) => Promise<boolean>;
  /** Resolve a sender address to a user id, or null. Allowed to fail; never fatal. */
  linkSender: (address: string) => Promise<string | null>;
  /** The audit seam. */
  emit: AuditEmit;
  /** The request/invocation logger. */
  log: Logger;
  /** Generate a row id. */
  newId: () => string;
  /** Now. */
  now: () => Date;
}

/** The message as it arrived, plus the envelope facts only the runtime knows. */
export interface IngestInput {
  /** The raw MIME bytes. */
  raw: ArrayBuffer;
  /** The SMTP envelope recipient — `ForwardableEmailMessage.to`. The authority on which inbox this is. */
  envelopeTo?: string;
  /** The SMTP envelope sender, for the log only. The `From` header is what a thread keys on. */
  envelopeFrom?: string;
}

/** Record a refusal. Never throws — a guard decision must not become a 500. */
async function auditRejection(
  deps: IngestDeps,
  reason: string,
  detail: string,
  fromAddress: string | undefined,
): Promise<void> {
  try {
    await deps.emit({
      action: SupportAuditActions.inboundRejected,
      outcome: "denied",
      severity: "warning",
      actorType: "anonymous",
      // Null, deliberately. An inbound sender is an unauthenticated claim in a header, and writing
      // an unverified identity into the trail as the actor is how a forged `From` gets to name
      // somebody. The address goes in metadata, where it reads as evidence rather than as identity.
      actorId: null,
      resourceType: "support_inbox",
      // The reason only. `detail` names the exact bound and the observed count, and the audit trail is
      // queryable and long-lived — the specifics belong in the log, which is bounded and already
      // carries the whole picture. Same split the control-plane seam makes.
      metadata: { reason, fromAddress: fromAddress ?? null },
    });
    deps.log.warn("support inbound message refused", { reason, detail, fromAddress: fromAddress ?? null });
  } catch (error) {
    deps.log.warn("support inbound rejection audit dropped", { reason, detail, error });
  }
}

/**
 * Find the thread a message continues, by walking its threading chain most-precise-first.
 *
 * The lookup goes through `pithy_support_messages.mime_message_id`, which is uniquely indexed — so
 * this is an index seek per candidate and the chain is bounded at 50 entries. It stops at the first
 * hit, which is why `parentCandidates` puts `In-Reply-To` ahead of a reversed `References`.
 */
async function findParentThread(
  db: SupportDatabase,
  parsed: ParsedInboundMessage,
  inbox: string,
): Promise<string | undefined> {
  const candidates = parentCandidates(parsed.inReplyTo, parsed.references);
  if (candidates.length === 0) return undefined;

  // Scoped to the inbox this message arrived on. A Worker can serve several — that is what
  // `thread.inboxAddress` exists for — and an unscoped match lets a message delivered to `security@`
  // graft itself onto a `support@` thread, which then keeps the *other* inbox's address and vanishes
  // from the filter its own recipient would use to find it.
  const parent = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .innerJoin(SUPPORT_THREADS_TABLE, `${SUPPORT_THREADS_TABLE}.id`, `${SUPPORT_MESSAGES_TABLE}.threadId`)
    .select([`${SUPPORT_MESSAGES_TABLE}.threadId`, `${SUPPORT_MESSAGES_TABLE}.mimeMessageId`])
    .where(`${SUPPORT_MESSAGES_TABLE}.mimeMessageId`, "in", candidates)
    .where(`${SUPPORT_THREADS_TABLE}.inboxAddress`, "=", inbox)
    .execute();
  if (parent.length === 0) return undefined;

  // Preserve the candidate ordering: the database returned rows in whatever order it liked, and the
  // whole point of the ordering is that the *nearest* ancestor wins.
  const byId = new Map(parent.map((row) => [row.mimeMessageId, row.threadId]));
  for (const candidate of candidates) {
    const threadId = byId.get(candidate);
    if (threadId !== undefined) return threadId;
  }
  return undefined;
}

/**
 * How many columns one `pithy_support_attachments` row binds. Derived from the schema rather than
 * written as a literal, so adding a column re-chunks instead of silently re-breaking the cap.
 */
const SUPPORT_ATTACHMENT_COLUMNS = Object.keys(SupportAttachment.shape).length;

/** Store the attachments this config allows, and return the rows written. */
async function storeAttachments(
  deps: IngestDeps,
  parsed: ParsedInboundMessage,
  threadId: string,
  messageId: string,
  now: Date,
): Promise<number> {
  const { attachments: bounds } = deps.config;
  const bucket = deps.bucket;
  if (!bounds.enabled || !bucket || parsed.attachments.length === 0) return 0;

  // Bound the count before the loop: how many parts a message has is a number the sender chose.
  const accepted = parsed.attachments.slice(0, bounds.maxCount);
  if (parsed.attachments.length > accepted.length) {
    deps.log.warn("support attachments truncated", {
      threadId,
      declared: parsed.attachments.length,
      stored: accepted.length,
    });
  }

  const rows: SupportAttachment[] = [];
  for (const attachment of accepted) {
    if (attachment.bytes.byteLength > bounds.maxBytes) {
      // Skipped, not fatal: the message it arrived on is the thing worth keeping, and an operator
      // who can see the metadata is better off than one whose mail silently vanished.
      deps.log.warn("support attachment skipped, over the size bound", {
        threadId,
        bytes: attachment.bytes.byteLength,
        maxBytes: bounds.maxBytes,
      });
      continue;
    }
    const id = deps.newId();
    const key = attachmentKey(threadId, id);
    await putAttachment(bucket, key, attachment.bytes);
    rows.push({
      id,
      messageId,
      threadId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.bytes.byteLength,
      sha256: await sha256Hex(attachment.bytes),
      storageKey: key,
      contentId: attachment.contentId ?? null,
      inline: attachment.inline,
      createdAt: now,
    });
  }

  // Chunked, because D1 binds one parameter per column per row and rejects a statement over 100 of
  // them. An attachment row is 11 columns, so the capability's own default `maxCount: 10` is 110
  // parameters — the default configuration failed, storing zero rows while the bytes were already in
  // R2, and the guard around this call turned that into a warn line nobody would see.
  const encoded = rows.map((row) => SupportAttachment.encode(row));
  for (const chunk of chunkRowsByBoundParameters(encoded, SUPPORT_ATTACHMENT_COLUMNS)) {
    await deps.db.insertInto(SUPPORT_ATTACHMENTS_TABLE).values(chunk).execute();
  }
  return rows.length;
}

/** Ingest one inbound message. */
export async function ingestInbound(deps: IngestDeps, input: IngestInput): Promise<IngestOutcome> {
  const now = deps.now();
  const rawBytes = input.raw.byteLength;

  // 1. Size, before parsing — the only check that is free.
  const size = checkSize(deps.config.guard, rawBytes);
  if (!size.accepted) {
    await auditRejection(deps, size.reason, size.detail, undefined);
    return { handled: false, reason: "rejected", rejection: size.reason };
  }

  // 2. Parse, then decide whether this message is ours at all.
  const parsed = await parseInbound(input.raw, { expectedAuthservId: deps.config.guard.authservId });
  const inbox = resolveInbox({
    inboundAddresses: deps.config.inboundAddresses,
    envelopeTo: input.envelopeTo,
    headerRecipients: parsed.headerRecipients,
  });
  if (inbox === undefined) return { handled: false, reason: "not_addressed" };

  // 3. Rate bounds, which cost a read.
  const rates = await checkRates(deps.db, deps.config.guard, {
    rawBytes,
    fromAddress: parsed.fromAddress,
    now,
  });
  if (!rates.accepted) {
    await auditRejection(deps, rates.reason, rates.detail, parsed.fromAddress);
    return { handled: false, reason: "rejected", rejection: rates.reason };
  }

  // 4. Idempotency. Email Routing redelivering is normal; a duplicate in somebody's inbox is not.
  // The unique index is the real guarantee — this read only makes the common case quiet rather than
  // a caught constraint violation.
  if (parsed.messageId !== undefined) {
    // Scoped to this inbox, matching the threading lookup. A Worker may serve several, and a customer
    // who addresses one message to both `support@` and `security@` causes two deliveries of the same
    // `Message-ID` — a global key would silently drop the second, so the message would appear in one
    // inbox and never in the other.
    const existing = await deps.db
      .selectFrom(SUPPORT_MESSAGES_TABLE)
      .select(["id", "threadId"])
      .where("mimeMessageId", "=", parsed.messageId)
      .where("toAddress", "=", inbox)
      .executeTakeFirst();
    if (existing) {
      deps.log.info("support message already stored, ignoring redelivery", { messageId: existing.id });
      return { handled: true, duplicate: true, threadId: existing.threadId, messageId: existing.id };
    }
  }

  // 5. Derive the stored bodies. Sanitization happens exactly here, once, on the way in — and the
  // raw form is kept, so a sanitizer improvement can be re-run over what actually arrived.
  const html = parsed.html !== undefined ? await sanitizeHtml(parsed.html) : undefined;
  // Bounded on both paths. `parseInbound` already caps the text part, but the HTML-only fallback is
  // derived here and was not — and an HTML-only message just under `guard.maxRawBytes` renders to a
  // multi-megabyte body that exceeds D1's row limit. The insert would then throw *after* the thread
  // row was written, and the handler swallows it, so the customer's mail is lost with a log line.
  const derived =
    parsed.text.trim().length > 0 ? parsed.text : parsed.html !== undefined ? await htmlToText(parsed.html) : "";
  const text = truncateToBytes(derived, MAX_TEXT_BODY);

  // Is the `From:` header something we may believe? The answer travels with the thread rather than
  // gating whether it is stored: an unverified sender is still matched to an account, because that is
  // the useful part and every mail client does it — but the thread records that the match was made on
  // an unproven header, and the read path withholds the billing history an operator would act on.
  const authenticity = senderAuthenticity({
    authResults: parsed.authResults,
    fromAddress: parsed.fromAddress,
    envelopeFrom: input.envelopeFrom,
    trusted: deps.config.guard.trustAuthenticationResults,
  });

  // Logged once per message, at info, because it is the one fact that decides whether in-Worker
  // sender authentication is even possible on this deployment — and it cannot be established from
  // documentation. An empty list means Cloudflare hands this Worker nothing to verify against, and
  // the honest-match design is the end of the road rather than a stepping stone. Issue #47.
  deps.log.info("support inbound authentication headers observed", {
    seen: parsed.authHeadersSeen,
    trusted: deps.config.guard.trustAuthenticationResults,
    authenticated: authenticity.authenticated,
  });

  const parentThreadId = await findParentThread(deps.db, parsed, inbox);
  const threadId = parentThreadId ?? deps.newId();
  const newThread = parentThreadId === undefined;
  const messageId = deps.newId();
  const subject = parsed.subject.length > 0 ? parsed.subject : "(no subject)";

  // 6. The raw MIME, immutable, before the row that points at it — so a stored row never names an
  // object that is not there.
  let rawKey: string | null = null;
  if (deps.bucket && deps.config.attachments.retainRaw) {
    rawKey = rawMessageKey(threadId, messageId);
    await deps.bucket.put(rawKey, input.raw, {
      httpMetadata: { contentType: "application/octet-stream", contentDisposition: "attachment" },
    });
  }

  // 7. The message first, and the ordering is deliberate. Its unique `mimeMessageId` index is the
  // last line of defense against a redelivery that raced past the read above — and when it fires,
  // this insert throws. Writing the thread first would leave that failure behind a thread row with a
  // message count and no messages, showing in the inbox as an empty conversation nobody can act on.
  // With the message first, a lost race writes nothing at all.
  const message: SupportMessage = {
    id: messageId,
    threadId,
    direction: "inbound",
    channel: "email",
    submittedByUserId: null,
    context: null,
    mimeMessageId: parsed.messageId ?? null,
    mimeInReplyTo: parsed.inReplyTo ?? null,
    mimeReferences: parsed.references.length > 0 ? parsed.references : null,
    fromAddress: parsed.fromAddress,
    fromName: parsed.fromName ?? null,
    toAddress: inbox,
    subject,
    textBody: text,
    htmlBody: html ?? null,
    emailJobId: null,
    rawKey,
    rawBytes,
    receivedAt: now,
    createdAt: now,
  };
  try {
    await deps.db.insertInto(SUPPORT_MESSAGES_TABLE).values(SupportMessage.encode(message)).execute();
  } catch (error) {
    // A concurrent redelivery is the expected cause, and it means the other invocation stored this
    // message already — so this is the same no-op the idempotency read above would have produced,
    // not a failure worth propagating.
    const existing = parsed.messageId
      ? await deps.db
          .selectFrom(SUPPORT_MESSAGES_TABLE)
          .select(["id", "threadId"])
          .where("mimeMessageId", "=", parsed.messageId)
          .where("toAddress", "=", inbox)
          .executeTakeFirst()
      : undefined;
    if (existing) {
      deps.log.info("support message stored concurrently, ignoring redelivery", { messageId: existing.id });
      return { handled: true, duplicate: true, threadId: existing.threadId, messageId: existing.id };
    }
    throw error;
  }

  // 8. The thread. A new one starts unclassified; an existing one has its counters moved forward.
  //
  // Wrapped, and the message row is removed if this fails. Message-before-thread is the right order —
  // it means a lost idempotency race writes nothing — but it leaves one failure the inverse does not:
  // a committed message with no thread. Because the idempotency read keys on that message, every
  // subsequent redelivery would then report `duplicate` and the conversation would be unrecoverable,
  // invisible to `listThreads` and `readThread` alike. Undoing the message restores the state where a
  // redelivery simply works.
  try {
    if (newThread) {
      // The user link is best-effort by contract: a sender who has no account is the normal case, and
      // an auth package that is not installed must not stop mail from being stored.
      //
      // Attempted regardless of authenticity, because the match is the useful part and every mail
      // client makes it. What authenticity changes is what we *claim*: the verdict is stored on the
      // thread, and the read path withholds the billing history an operator would act on when it is
      // false. A labeled guess is honest; a guess dressed as a verified fact is account takeover.
      let userId: string | null = null;
      try {
        userId = await deps.linkSender(parsed.fromAddress);
      } catch (error) {
        deps.log.warn("support sender link failed", { error });
      }
      if (userId && !authenticity.authenticated) {
        deps.log.info("support sender matched on an unverified From address", { method: authenticity.method });
      }

      const thread: SupportThread = {
        id: threadId,
        channel: "email",
        inboxAddress: inbox,
        subject,
        fromAddress: parsed.fromAddress,
        fromName: parsed.fromName ?? null,
        senderAuthenticated: authenticity.authenticated,
        userId,
        // Matched from an address in a header, which is the weaker of the two provenances and the
        // reason the column exists. Null when nothing matched — an absent link has no source.
        accountLinkSource: userId ? "email_address" : null,
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
      // Re-attempt the link when the thread has none. `data/thread.ts` states the intent plainly — the
      // link is derived, so "a customer who signs up later is linked by the next message rather than
      // by a repair" — and doing it only on the new-thread branch froze `userId` at whatever was true
      // when the conversation opened, which for anyone who wrote in *before* signing up is null
      // forever.
      let linkedNow: string | null = null;
      if (authenticity.authenticated) {
        const current = await deps.db
          .selectFrom(SUPPORT_THREADS_TABLE)
          .select(["userId"])
          .where("id", "=", threadId)
          .executeTakeFirst();
        if (current?.userId == null) {
          try {
            linkedNow = await deps.linkSender(parsed.fromAddress);
          } catch (error) {
            deps.log.warn("support sender re-link failed", { error });
          }
        }
      }

      await deps.db
        .updateTable(SUPPORT_THREADS_TABLE)
        .set((eb) => ({
          ...(linkedNow
            ? { userId: linkedNow, senderAuthenticated: 1 as const, accountLinkSource: "email_address" as const }
            : {}),
          messageCount: eb("messageCount", "+", 1),
          lastMessageAt: now.getTime(),
          updatedAt: now.getTime(),
          // A reply to a resolved thread reopens it. Anything else means a customer wrote back and
          // nobody saw it, which is the one failure a support inbox cannot have.
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
        // Nothing further to do: the message row survives and the next redelivery reports a duplicate
        // it cannot act on. Logged so the orphan is at least findable.
        deps.log.error("support message orphaned — thread write failed and the message could not be removed", {
          messageId,
          threadId,
        });
      });
    throw error;
  }

  // The full-text index, when it is composed. Best-effort by contract: a failed index write must
  // never lose a customer's message, so it is logged and the ingest continues. The row is stored,
  // readable, and repairable by `reindexThread` — it is only missing from one search box.
  if (deps.fts) {
    try {
      await indexMessage(deps.db, { threadId, messageId, subject, body: text });
    } catch (error) {
      deps.log.warn("support message not indexed", { messageId, error });
    }
  }

  // Guarded for the same reason the index write and the dispatch are, and the consequence here is
  // the worst of the three. This runs *after* the message and thread rows are committed but *before*
  // the classification dispatch — so a transient `bucket.put` failure throws out of ingest, the
  // handler swallows it, and the message is durable but was never classified. An Email Routing
  // redelivery then finds the row and returns `duplicate`, so it never retries: the thread stays
  // `uncategorized` forever, fixable only by a human noticing and reclassifying by hand.
  //
  // Attachments are already best-effort by policy — an oversize one is skipped rather than fatal —
  // so a bucket that is briefly unavailable should cost the same: the attachments, not the message.
  let attachments = 0;
  try {
    attachments = await storeAttachments(deps, parsed, threadId, messageId, now);
  } catch (error) {
    deps.log.warn("support attachments not stored", { messageId, error });
  }

  // 9. Classification, last and allowed to fail. An out-of-office is not worth an inference, and an
  // adopter who turned classification off should pay nothing for it.
  const classifying = deps.config.ai.enabled && !parsed.autoSubmitted;
  if (classifying) {
    try {
      await deps.dispatchClassify(messageId);
    } catch (error) {
      // The message is already durable. A failed dispatch means a thread stays `uncategorized`,
      // which is a legitimate state and a reclassify away from being fixed.
      deps.log.warn("support classification dispatch failed", { messageId, error });
    }
  }

  return { handled: true, duplicate: false, threadId, messageId, newThread, attachments, classifying };
}
