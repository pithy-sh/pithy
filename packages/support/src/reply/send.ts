// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { SupportAuditActions } from "../audit/actions";
import type { SupportConfig } from "../config/config";
import { SupportMessage } from "../data/message";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, type SupportDatabase } from "../data/tables";
import { SupportNotFoundError, SupportReplyFailedError } from "../error/errors";
import { buildReferencesHeader, replySubject } from "../mime/threading";
import { indexMessage } from "../store/search";

/**
 * Sending a reply — through `@pithy-sh/email`'s durable send path, never directly.
 *
 * ## Why the reply is composed here and not in the dashboard
 *
 * Three things have to be true of an answer, and a dashboard can guarantee none of them. It has to
 * leave from the adopter's domain carrying the adopter's DKIM, so it is not filtered as a forgery.
 * It has to be durable and retryable, which is what the email capability's job row and Workflow buy.
 * And it has to set `In-Reply-To` and `References` correctly — which only the Worker can do, because
 * only the Worker holds the thread's chain. Implemented dashboard-side, threading breaks in the
 * customer's mail client and every conversation fragments into one message per answer.
 *
 * So the dashboard POSTs a body. That is the entire contract, and it is why the reply route is small.
 *
 * ## The sent Message-ID is not ours to know
 *
 * Cloudflare assigns the real `Message-ID` at send time and does not tell the enqueuer, so the
 * outbound row stores `emailJobId` and leaves `mimeMessageId` null. Threading back still works, and
 * this is the part worth being clear about: when the customer replies, their `References` carries the
 * whole ancestry — including the *inbound* ids this capability stored itself — so `parentCandidates`
 * finds the thread through one of those even though it has never seen the id of its own reply.
 */

/** What a reply needs, all injectable. */
export interface ReplyDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The resolved config. */
  config: SupportConfig;
  /**
   * The email capability's `enqueue`, already bound to the request env. Support never assembles the
   * send infrastructure — it hands over a recipient, a template id, and a payload.
   */
  enqueue: (input: {
    to: string;
    template: string;
    payload: unknown;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
  }) => Promise<{ jobId: string }>;
  /** Whether the full-text index is in use. */
  fts: boolean;
  /** The audit seam. */
  emit: AuditEmit;
  /** The request logger. */
  log: Logger;
  /** Generate a row id. */
  newId: () => string;
  /** Now. */
  now: () => Date;
}

/** What the operator is sending. */
export interface ReplyInput {
  /** The thread being answered. */
  threadId: string;
  /** The reply text, as a human wrote and edited it. */
  body: string;
  /** Who is answering, signed at the bottom. Optional. */
  agentName?: string;
  /** The verified control-plane subject sending it — the audit actor. */
  viewer: string;
}

/** What the reply produced. */
export interface ReplyResult {
  /** The outbound `pithy_support_messages.id`. */
  messageId: string;
  /** The `pithy_email_jobs.id` the send was enqueued as. */
  jobId: string;
}

/** Send a reply on a thread. */
export async function sendReply(deps: ReplyDeps, input: ReplyInput): Promise<ReplyResult> {
  if (!deps.config.reply.enabled) {
    throw new SupportReplyFailedError({
      message: "Replying is disabled on this deployment.",
      action: "Set `reply.enabled` on the support capability in pithy.config.ts, then redeploy.",
      detail: "support config has reply.enabled = false",
    });
  }

  const thread = await deps.db
    .selectFrom(SUPPORT_THREADS_TABLE)
    .select(["id", "subject", "fromAddress", "fromName", "inboxAddress", "messageCount"])
    .where("id", "=", input.threadId)
    .executeTakeFirst();
  if (!thread) throw new SupportNotFoundError({ detail: `no support thread ${input.threadId}` });

  // The parent is the newest *inbound* message: the customer's last word is what an answer answers,
  // and threading against our own previous reply would chain the conversation to a message whose
  // real id we never learned.
  const parent = await deps.db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["mimeMessageId", "mimeReferences"])
    .where("threadId", "=", input.threadId)
    .where("direction", "=", "inbound")
    .orderBy("receivedAt", "desc")
    // Tiebroken on id: two messages can share a millisecond (a redelivery burst, or a fixed clock in
    // a test), and without it "the latest inbound message" is whichever the database felt like —
    // so a reclassify or a reply could thread against the wrong parent.
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  const parentReferences = SupportMessage.shape.mimeReferences.safeParse(parent?.mimeReferences);
  const chain = parentReferences.success && Array.isArray(parentReferences.data) ? parentReferences.data : [];
  const references = buildReferencesHeader(chain, parent?.mimeMessageId ?? undefined);
  const subject = replySubject(thread.subject);
  const now = deps.now();

  // The customer's answer has to come back to an address this inbox actually claims, or the
  // conversation ends at the reply. Defaulting to the inbox the thread arrived on is right for every
  // deployment that has not deliberately configured otherwise.
  const replyTo = deps.config.reply.replyToAddress ?? thread.inboxAddress;

  let jobId: string;
  try {
    const enqueued = await deps.enqueue({
      to: thread.fromAddress,
      template: "supportReply",
      payload: { subject, body: input.body, ...(input.agentName ? { agentName: input.agentName } : {}) },
      replyTo,
      inReplyTo: parent?.mimeMessageId ? `<${parent.mimeMessageId}>` : undefined,
      references: references.length > 0 ? references : undefined,
    });
    jobId = enqueued.jobId;
  } catch (cause) {
    throw new SupportReplyFailedError({ detail: `enqueue failed for thread ${input.threadId}` }, { cause });
  }

  // The outbound row goes in after the enqueue succeeded, so the thread never shows a reply that was
  // never accepted for sending.
  const messageId = deps.newId();
  const message: SupportMessage = {
    id: messageId,
    threadId: input.threadId,
    direction: "outbound",
    mimeMessageId: null,
    mimeInReplyTo: parent?.mimeMessageId ?? null,
    mimeReferences: chain.length > 0 ? chain : null,
    fromAddress: replyTo,
    fromName: null,
    toAddress: thread.fromAddress,
    subject,
    textBody: input.body,
    htmlBody: null,
    emailJobId: jobId,
    rawKey: null,
    rawBytes: null,
    receivedAt: now,
    createdAt: now,
  };
  await deps.db.insertInto(SUPPORT_MESSAGES_TABLE).values(SupportMessage.encode(message)).execute();

  if (deps.fts) {
    try {
      await indexMessage(deps.db, { threadId: input.threadId, messageId, subject, body: input.body });
    } catch (error) {
      // A search miss, never a lost reply. `reindexThread` is the repair.
      deps.log.warn("support reply not indexed", { messageId, error });
    }
  }

  await deps.db
    .updateTable(SUPPORT_THREADS_TABLE)
    .set((eb) => ({
      messageCount: eb("messageCount", "+", 1),
      lastMessageAt: now.getTime(),
      updatedAt: now.getTime(),
    }))
    .where("id", "=", input.threadId)
    .execute();

  // Audited because it leaves under the adopter's domain and their DKIM: to the recipient it is
  // indistinguishable from the founder writing it, so who actually sent it is a security-relevant
  // fact with no other record. The body is never in the metadata — the trail is long-lived and
  // queryable, and a support reply is somebody's private correspondence.
  await deps.emit({
    action: SupportAuditActions.replySent,
    outcome: "success",
    actorType: "control-plane",
    actorId: input.viewer,
    resourceType: "support_thread",
    resourceId: input.threadId,
    metadata: { jobId, messageId, threaded: Boolean(parent?.mimeMessageId) },
  });

  return { messageId, jobId };
}
