// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { ObjectStore } from "@pithy-sh/storage/src/object/store";
import { attachmentUrl } from "../attachment/store";
import { SupportAuditActions } from "../audit/actions";
import type { SupportConfig } from "../config/config";
import type { SupportAttachment } from "../data/attachment";
import type { SupportCategories } from "../data/categories";
import type { SupportDatabase } from "../data/tables";
import { SupportClassificationError, SupportNotFoundError } from "../error/errors";
import { resolveSenderContext } from "../link/sender";
import { sendReply } from "../reply/send";
import type { SupportReplySnippets } from "../reply/snippets";
import { repliesForCategory } from "../reply/snippets";
import { listThreads, readThread, setArchived, setFlags } from "../store/threads";
import { latestInboundMessageId } from "../workflows/classify";
import type {
  SupportAttachmentView,
  SupportFlagsResponse,
  SupportReclassifiedResponse,
  SupportReplySentResponse,
  SupportReplyView,
  SupportThreadResponse,
  SupportThreadsResponse,
  SupportThreadView,
} from "./responses";
import type { ArchiveThreadInput, FlagsInput, ListThreadsQuery, RepliesQuery, ReplyInput } from "./schemas";
import { listedThreadView, messageView, senderView, threadView } from "./views";

/**
 * The support handlers — every one of them behind the `control-plane` gate, and every one of them
 * taking already-validated values.
 *
 * Nothing here reads raw request input: the route line carries the contract and the handler takes
 * typed arguments, which is what lets these be tested without a request at all.
 */

/** Everything the handlers need, resolved per request. */
export interface HandlerDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The raw `DB` binding — the linkage reads sibling capabilities' tables through it. */
  d1: D1Database;
  /** The resolved config. */
  config: SupportConfig;
  /** The effective taxonomy. */
  categories: SupportCategories;
  /** The effective canned-reply catalog. */
  snippets: SupportReplySnippets;
  /** Whether the FTS5 index is composed. */
  fts: boolean;
  /** The attachment bucket, when one is bound. */
  bucket?: R2Bucket;
  /** The object store attachment URLs are signed through, when credentials are available. */
  store?: ObjectStore;
  /** The email capability's env-bound `enqueue`, when email is composed. */
  enqueue?: Parameters<typeof sendReply>[0]["enqueue"];
  /** Start a classification for a message. Resolves to whether an instance actually started. */
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

/** List the inbox. */
export async function listInbox(
  deps: HandlerDeps,
  query: ListThreadsQuery,
  viewer: string,
): Promise<SupportThreadsResponse> {
  const page = await listThreads(
    deps.db,
    {
      archived: query.archived === "true",
      category: query.category,
      priority: query.priority,
      sentiment: query.sentiment,
      inbox: query.inbox,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    },
    { fts: deps.fts, viewer, now: deps.now(), log: deps.log },
  );
  return { threads: page.threads.map(listedThreadView), nextCursor: page.nextCursor };
}

/**
 * Present an attachment.
 *
 * The `storageKey` is **never** in the response. It is server-derived and opaque precisely so a
 * client cannot name an object or guess the one beside it, and echoing it back would hand that
 * capability away for no benefit — a client cannot use a key for anything except guessing.
 */
async function presentAttachments(
  deps: HandlerDeps,
  attachments: readonly SupportAttachment[],
): Promise<SupportAttachmentView[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      let url: string | null = null;
      if (deps.store) {
        try {
          url = await attachmentUrl(deps.store, attachment.storageKey);
        } catch (error) {
          // A thread whose attachment cannot be signed is still a thread worth reading.
          deps.log.warn("support attachment URL not signed", { attachmentId: attachment.id, error });
        }
      }
      return {
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        sha256: attachment.sha256,
        inline: attachment.inline,
        url,
      };
    }),
  );
}

/** Read one conversation in full. */
export async function readConversation(deps: HandlerDeps, threadId: string): Promise<SupportThreadResponse> {
  const detail = await readThread(deps.db, threadId);
  const [attachments, sender] = await Promise.all([
    presentAttachments(deps, detail.attachments),
    resolveSenderContext(deps.d1, detail.thread.fromAddress, deps.now(), {
      authenticated: detail.thread.senderAuthenticated,
    }),
  ]);

  return {
    thread: threadView(detail.thread),
    messages: detail.messages.map(messageView),
    attachments,
    sender: senderView(sender),
    replies: repliesForCategory(deps.snippets, detail.thread.category),
  };
}

/** Mark a conversation done, or reopen it. */
export async function archiveConversation(
  deps: HandlerDeps,
  threadId: string,
  input: ArchiveThreadInput,
  viewer: string,
): Promise<SupportThreadView> {
  const thread = await setArchived(deps.db, threadId, input.archived, viewer, deps.now());

  // The audit event is what makes "who marked this done" answerable, and it is exactly why the model
  // gets away with having no ownership column.
  await deps.emit({
    action: input.archived ? SupportAuditActions.threadArchived : SupportAuditActions.threadUnarchived,
    outcome: "success",
    actorType: "control-plane",
    actorId: viewer,
    resourceType: "support_thread",
    resourceId: threadId,
    metadata: { archived: input.archived },
  });

  return threadView(thread);
}

/** Answer the customer. */
export async function replyToConversation(
  deps: HandlerDeps,
  threadId: string,
  input: ReplyInput,
  viewer: string,
): Promise<SupportReplySentResponse> {
  const enqueue = deps.enqueue;
  if (!enqueue) {
    throw new (await import("../error/errors")).SupportReplyFailedError({
      message: "This deployment cannot send mail.",
      action: "Add the email capability (`pithy add email`) and provision it, then retry.",
      detail: "no email capability composed, so no enqueue is bound to the request",
    });
  }

  return sendReply(
    {
      db: deps.db,
      config: deps.config,
      enqueue,
      fts: deps.fts,
      emit: deps.emit,
      log: deps.log,
      newId: deps.newId,
      now: deps.now,
    },
    { threadId, body: input.body, agentName: input.agentName, viewer },
  );
}

/** Re-run the classifier over a conversation's latest inbound message. */
export async function reclassifyConversation(
  deps: HandlerDeps,
  threadId: string,
  viewer: string,
): Promise<SupportReclassifiedResponse> {
  const messageId = await latestInboundMessageId(deps.db, threadId);
  if (!messageId) {
    throw new SupportNotFoundError({
      message: "That conversation has nothing to classify.",
      detail: `thread ${threadId} has no inbound message`,
    });
  }

  const dispatched = await deps.dispatchClassify(messageId);
  if (!dispatched) {
    // The Workflow binding is optional, so an unprovisioned project reaches here and `triggerWorkflow`
    // degrades to a logged skip. Returning 200 anyway would tell a human "reclassified" while nothing
    // ran — forever, and with a success event in the audit trail to corroborate it.
    throw new SupportClassificationError({
      message: "Classification is not available on this deployment.",
      action: "Run `pithy support provision` to deploy the classification worker, then retry.",
      detail: `the ${"SUPPORT_CLASSIFY"} workflow binding is absent, so no instance was started`,
    });
  }

  // Audited because it rewrites a judgement about a customer's message, and because a run of them is
  // what somebody fishing for a different answer looks like.
  await deps.emit({
    action: SupportAuditActions.threadReclassified,
    outcome: "success",
    actorType: "control-plane",
    actorId: viewer,
    resourceType: "support_thread",
    resourceId: threadId,
    metadata: { messageId },
  });

  return { messageId };
}

/** Set one viewer's private flags. */
export async function updateFlags(
  deps: HandlerDeps,
  threadId: string,
  input: FlagsInput,
  viewer: string,
): Promise<SupportFlagsResponse> {
  await setFlags(deps.db, {
    threadId,
    viewer,
    read: input.read,
    snoozedUntil:
      input.snoozedUntil === undefined ? undefined : input.snoozedUntil ? new Date(input.snoozedUntil) : null,
    newId: deps.newId,
    now: deps.now(),
  });
  // Not audited, deliberately: a private read flag is not a security-relevant action, and writing one
  // event per thread somebody scrolled past would bury the events that are.
  return { ok: true };
}

/** The canned reply catalog. */
export function listReplies(deps: HandlerDeps, query: RepliesQuery): SupportReplyView[] {
  return repliesForCategory(deps.snippets, query.category ?? "");
}
