// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { ObjectStore } from "@pithy-sh/storage/src/object/store";
import { attachmentUrl } from "../attachment/store";
import { SupportAuditActions } from "../audit/actions";
import type { SupportConfig } from "../config/config";
import type { SupportAttachment } from "../data/attachment";
import type { SupportCategories } from "../data/categories";
import type { SupportDatabase } from "../data/tables";
import { SupportClassificationError, SupportNotFoundError } from "../error/errors";
import { resolveSenderContext, resolveSubmitterAccount, resolveSubmitterContext } from "../link/sender";
import { sendReply } from "../reply/send";
import type { SupportReplySnippets } from "../reply/snippets";
import { repliesForCategory } from "../reply/snippets";
import { listOwnThreads, listThreads, readOwnThread, readThread, setArchived, setFlags } from "../store/threads";
import { decodeBase64 } from "../submission/encoding";
import { submitFeedback } from "../submission/submit";
import { latestInboundMessageId } from "../workflows/classify";
import type {
  SupportAttachmentView,
  SupportFlagsResponse,
  SupportMyThreadResponse,
  SupportMyThreadsResponse,
  SupportReclassifiedResponse,
  SupportReplySentResponse,
  SupportReplyView,
  SupportSubmissionResponse,
  SupportThreadResponse,
  SupportThreadsResponse,
  SupportThreadView,
} from "./responses";
import type {
  ArchiveThreadInput,
  FlagsInput,
  ListThreadsQuery,
  MyThreadsQuery,
  RepliesQuery,
  ReplyInput,
  SubmitFeedbackInput,
} from "./schemas";
import { listedThreadView, messageView, myMessageView, myThreadView, senderView, threadView } from "./views";

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
      declaredCategory: query.declaredCategory,
      priority: query.priority,
      sentiment: query.sentiment,
      channel: query.channel,
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
    // A session-proven thread already holds the id its session established, so the context is resolved
    // from that rather than re-derived from an address. Not a shortcut: `resolveSenderUserId` matches
    // the `email` column exactly, so an account stored with capitals by some other route would resolve
    // to nobody — turning the one link that *is* certain into the one the console shows as unknown.
    detail.thread.accountLinkSource === "session" && detail.thread.userId
      ? resolveSubmitterContext(deps.d1, detail.thread.userId, deps.now())
      : resolveSenderContext(deps.d1, detail.thread.fromAddress, deps.now(), {
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
  // `enqueue` is passed through absent rather than refused here. Whether a reply needs mail at all is
  // `sendReply`'s decision — an `app` thread is answered in the app when there is nothing to send
  // with — and a check at this call site would refuse the request before the one function that knows
  // ever got to look.
  return sendReply(
    {
      db: deps.db,
      config: deps.config,
      enqueue: deps.enqueue,
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

/**
 * Take an in-app support request from a signed-in user.
 *
 * `userId` is a parameter rather than something read out of `input`, and that is the contract this
 * whole channel rests on: it comes from `c.var.auth`, which `requireAuth()` filled before the route's
 * validator ran. Nothing in the submitted body names an account, and the schema has no field that
 * could.
 *
 * The configured length bounds are applied here rather than in the schema, for the reason
 * `schemas.ts` states: a request schema is built once at module load and the adopter's numbers are
 * resolved per project. This is config-backed resolution, which belongs in a handler — the same rule
 * that keeps `board()` and `currency()` lookups out of a param schema.
 */
export async function submitFeedbackRequest(
  deps: HandlerDeps,
  input: SubmitFeedbackInput,
  userId: string,
): Promise<SupportSubmissionResponse> {
  const bounds = deps.config.submission;
  if (input.subject.length > bounds.maxSubjectChars) {
    throw new ValidationError({
      message: `A subject may be at most ${bounds.maxSubjectChars} characters.`,
      action: "Shorten the subject and try again.",
      detail: `submitted subject is ${input.subject.length} characters, over the ${bounds.maxSubjectChars} bound`,
    });
  }
  if (input.body.length > bounds.maxBodyChars) {
    throw new ValidationError({
      message: `A support request may be at most ${bounds.maxBodyChars} characters.`,
      action: "Shorten the message and try again, or attach the detail as a file.",
      detail: `submitted body is ${input.body.length} characters, over the ${bounds.maxBodyChars} bound`,
    });
  }
  // **The count bound belongs here, ahead of the decode, and not only inside `submitFeedback`.**
  // `decodeBase64` bounds each payload before it allocates, but nothing bounded *how many* of them a
  // request could carry until the array had already been mapped — so the cheapest refusal in the whole
  // path sat behind the most expensive step in it. `submitFeedback` checks the same bound again for
  // any caller that reaches it directly.
  if (input.attachments.length > bounds.attachments.maxCount) {
    throw new ValidationError({
      message: `A support request may carry at most ${bounds.attachments.maxCount} attachments.`,
      action: `Send at most ${bounds.attachments.maxCount} files.`,
      detail: `submission declared ${input.attachments.length} attachments, over the ${bounds.attachments.maxCount} bound`,
    });
  }

  const outcome = await submitFeedback(
    {
      db: deps.db,
      config: deps.config,
      // The capability's own merged taxonomy, handed straight through. The declared-category check is
      // `submitFeedback`'s rather than this handler's on purpose: a bound that decides what may be
      // *stored* belongs with the write, so it holds for every caller and not only for HTTP.
      categories: deps.categories,
      bucket: deps.bucket,
      fts: deps.fts,
      resolveAccount: (id) => resolveSubmitterAccount(deps.d1, id),
      dispatchClassify: deps.dispatchClassify,
      emit: deps.emit,
      log: deps.log,
      newId: deps.newId,
      now: deps.now,
    },
    {
      userId,
      subject: input.subject,
      body: input.body,
      declaredCategory: input.declaredCategory,
      threadId: input.threadId,
      context: input.context,
      // Decoded here, at the transport boundary, so `submitFeedback` takes bytes and stays testable
      // without a request — the same split `ingest.ts` has from the `email()` handler. The decode is
      // bounded before it allocates: `atob` materialises the whole result, so a size check afterwards
      // has already paid for the attack it was meant to refuse.
      attachments: input.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes: decodeBase64(attachment.data, { maxBytes: bounds.attachments.maxBytes }),
      })),
    },
  );

  return {
    threadId: outcome.threadId,
    messageId: outcome.messageId,
    opened: outcome.newThread,
    attachments: outcome.attachments,
  };
}

/** List the caller's own in-app conversations. */
export async function listMyThreads(
  deps: HandlerDeps,
  query: MyThreadsQuery,
  userId: string,
): Promise<SupportMyThreadsResponse> {
  const page = await listOwnThreads(deps.db, userId, { cursor: query.cursor, limit: query.limit });
  return { threads: page.threads.map(myThreadView), nextCursor: page.nextCursor };
}

/**
 * Read one of the caller's own conversations.
 *
 * The scoping is `readOwnThread`'s `where`, so a thread belonging to somebody else raises the same
 * `support/not_found` as one that never existed. The projection is `myThreadView`/`myMessageView`,
 * built from scratch rather than by omitting fields from the operator's — see `views.ts` for why that
 * distinction is the security boundary rather than a style preference.
 */
export async function readMyThread(
  deps: HandlerDeps,
  threadId: string,
  userId: string,
): Promise<SupportMyThreadResponse> {
  const detail = await readOwnThread(deps.db, threadId, userId);
  const attachments = await presentAttachments(deps, detail.attachments);
  const byMessage = new Map<string, SupportAttachmentView[]>();
  for (const [index, attachment] of detail.attachments.entries()) {
    const view = attachments[index];
    if (!view) continue;
    const bucket = byMessage.get(attachment.messageId);
    if (bucket) bucket.push(view);
    else byMessage.set(attachment.messageId, [view]);
  }

  return {
    thread: myThreadView(detail.thread),
    messages: detail.messages.map((message) => myMessageView(message, byMessage.get(message.id) ?? [])),
  };
}
