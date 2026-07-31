// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SupportAi } from "../ai/classify";
import { classifyMessage } from "../ai/classify";
import type { SupportAiConfig } from "../config/config";
import type { SupportCategories } from "../data/categories";
import { SupportClassification } from "../data/classification";
import { SPAM } from "../data/enums";
import {
  SUPPORT_CLASSIFICATIONS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  type SupportDatabase,
} from "../data/tables";

/**
 * The classification orchestration — the pure, testable core the Workflow step runs.
 *
 * Reads a message, asks the model about it, **appends** a classification row, and denormalizes the
 * answer onto its thread. The two writes are deliberate and asymmetric: the history is append-only
 * so a model upgrade is visible in the data rather than a silent rewrite, and the thread carries only
 * the current answer because that is what the inbox query reads.
 *
 * Idempotent by construction. Re-running over the same message appends a second row and overwrites
 * the same three thread columns with a fresh judgement — which is what makes a Workflow retry, a
 * manual reclassify, and a post-upgrade backfill the same operation.
 */

/** Everything classification needs, all injectable. */
export interface ClassifyDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The Workers AI binding. */
  ai: SupportAi;
  /** The effective taxonomy — the defaults plus the adopter's. */
  categories: SupportCategories;
  /** Model, bounds, and temperature. */
  ai_config: SupportAiConfig;
  /**
   * Archive a thread the classifier calls `spam`, so it never reaches the open inbox.
   *
   * **Archived, never deleted.** The classifier is wrong sometimes, and a pass that destroyed mail
   * would be untrustworthy the first time it was — whereas an archived thread is still readable under
   * the archived filter and one click from being back. That is what makes `spam` a filter rather than
   * a bin, and it is why this is safe to have on by default.
   */
  archiveSpam: boolean;
  /** Generate a row id. */
  newId: () => string;
  /** Now. */
  now: () => Date;
}

/** What one classification run did. `null` when the message no longer exists. */
export interface ClassifyOutcome {
  /** The thread the classification landed on. */
  threadId: string;
  /** The category chosen. */
  category: string;
  /** The model's confidence. */
  confidence: number;
  /** The model that produced it. */
  model: string;
  /** Whether this run archived the thread because it classified as spam. */
  archivedAsSpam: boolean;
}

/** Classify one stored message and write the result. Returns null when the message is gone. */
export async function runClassification(deps: ClassifyDeps, messageId: string): Promise<ClassifyOutcome | null> {
  const message = await deps.db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["id", "threadId", "subject", "textBody"])
    .where("id", "=", messageId)
    .executeTakeFirst();
  // Not an error. A Workflow instance can outlive the row that started it, and a retry after a
  // rollback is the ordinary way that happens.
  if (!message) return null;

  const result = await classifyMessage(deps.ai, {
    categories: deps.categories,
    subject: message.subject,
    body: message.textBody,
    model: deps.ai_config.model,
    maxChars: deps.ai_config.maxChars,
    temperature: deps.ai_config.temperature,
  });

  const now = deps.now();

  await deps.db
    .insertInto(SUPPORT_CLASSIFICATIONS_TABLE)
    .values(
      SupportClassification.encode({
        id: deps.newId(),
        threadId: message.threadId,
        messageId: message.id,
        category: result.category,
        priority: result.priority,
        sentiment: result.sentiment,
        confidence: result.confidence,
        model: result.model,
        createdAt: now,
      }),
    )
    .execute();

  // Spam gets archived in the same write that classifies it, not a second pass — otherwise there is a
  // window where it sits in somebody's open inbox, which is the whole thing this avoids.
  const archivedAsSpam = deps.archiveSpam && result.category === SPAM;

  await deps.db
    .updateTable(SUPPORT_THREADS_TABLE)
    .set({
      category: result.category,
      priority: result.priority,
      sentiment: result.sentiment,
      confidence: result.confidence,
      model: result.model,
      classifiedAt: now.getTime(),
      updatedAt: now.getTime(),
      ...(archivedAsSpam
        ? {
            archived: 1 as const,
            archivedAt: now.getTime(),
            // The model, named as the actor. An operator looking at why a thread is archived should
            // see that nobody decided it — and `archivedBy` is exactly where they will look.
            archivedBy: result.model,
          }
        : {}),
    })
    .where("id", "=", message.threadId)
    .execute();

  return {
    threadId: message.threadId,
    category: result.category,
    confidence: result.confidence,
    model: result.model,
    archivedAsSpam,
  };
}

/**
 * The message a manual reclassify runs against: a thread's most recent **inbound** message.
 *
 * Inbound, not latest — a thread whose last message is our own reply would otherwise be reclassified
 * on the text the adopter wrote, which says nothing about what the customer wanted.
 */
export async function latestInboundMessageId(db: SupportDatabase, threadId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["id"])
    .where("threadId", "=", threadId)
    .where("direction", "=", "inbound")
    .orderBy("receivedAt", "desc")
    // Tiebroken on id: two messages can share a millisecond (a redelivery burst, or a fixed clock in
    // a test), and without it "the latest inbound message" is whichever the database felt like —
    // so a reclassify or a reply could thread against the wrong parent.
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}
