// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { VectorIndexConfig } from "@pithy-sh/vector/src/config/config";
import { embedForIndex, type VectorAi } from "@pithy-sh/vector/src/embed/embed";
import { upsertVectors, type VectorStore } from "@pithy-sh/vector/src/index/index";
import { SUPPORT_MESSAGES_TABLE, type SupportDatabase } from "../data/tables";
import { writeStamps } from "./documents";
import { embeddingText } from "./messageIndex";

/**
 * Embed one stored message into the semantic index — the step the classification Workflow runs after it
 * classifies.
 *
 * **The vector is written, then the stamp.** A step that dies between the two leaves a message with no stamp,
 * which is exactly the set `pithy vector reprocess --index support-messages` picks up, so a half-done write heals
 * rather than hides.
 *
 * **A message gone by the stamp keeps no vector.** The stamp is written only while the message exists, and a
 * message deleted between the read and the upsert has its vector deleted again, so a purge that lands mid-step
 * leaves nothing derived from the person's words.
 *
 * **Ids only.** The upsert carries the message id and the components, and no metadata at all.
 */

/** What embedding a message needs. Every one is a seam, so a test hands in fakes. */
export interface EmbedMessageDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** The Workers AI binding. */
  ai: VectorAi;
  /** The Vectorize binding the message index arrives on. */
  store: VectorStore;
  /** The index's config — the model it is pinned to and the width it holds. */
  index: VectorIndexConfig;
  /** Now. */
  now: () => Date;
}

/** Embed one message and stamp it. Returns false when the message no longer exists, read or stamp. */
export async function embedMessage(deps: EmbedMessageDeps, messageId: string): Promise<boolean> {
  const message = await deps.db
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .select(["id", "subject", "textBody"])
    .where("id", "=", messageId)
    .executeTakeFirst();
  // A Workflow instance can outlive the row that started it; a purge is the ordinary way.
  if (!message) return false;

  const [values] = await embedForIndex(deps.ai, deps.index, [embeddingText(message.subject, message.textBody)]);
  await upsertVectors(deps.store, deps.index, [{ id: message.id, values: values as number[] }]);

  // A message deleted since the read gets no stamp, and its vector is deleted again.
  const stamped = await writeStamps(deps.db, deps.store, [message.id], deps.index.model, deps.now());
  return stamped.has(message.id);
}

/** What one embedding step did. Returned through the step, so a replay restores it. */
export type EmbedOutcome =
  | { embedded: true }
  | {
      embedded: false;
      /**
       * `gone` — the message no longer exists. `unbound` — the index's binding is not on this worker yet, until
       * `pithy support provision` deploys it. `failed` — the model or the index did not answer.
       */
      reason: "gone" | "unbound" | "failed";
    };

/**
 * The embedding step, as the classification Workflow runs it: **never fatal**.
 *
 * A message that could not be embedded is stored, classified, and missing from semantic results only — and,
 * having no stamp, it is exactly what the next `pithy vector reprocess --index support-messages` picks up. So a
 * failure is reported in the outcome and the log, and never thrown into the Workflow that also classifies.
 */
export async function runEmbedding(
  deps: Omit<EmbedMessageDeps, "store"> & { store: VectorStore | undefined; log?: Logger },
  messageId: string,
): Promise<EmbedOutcome> {
  if (!deps.store) {
    deps.log?.warn("support semantic search is on but the index is not bound to this worker — not embedding", {
      messageId,
    });
    return { embedded: false, reason: "unbound" };
  }
  try {
    return (await embedMessage({ ...deps, store: deps.store }, messageId))
      ? { embedded: true }
      : { embedded: false, reason: "gone" };
  } catch (error) {
    deps.log?.warn("support message not embedded — it stays out of semantic results until a reprocess", {
      messageId,
      error,
    });
    return { embedded: false, reason: "failed" };
  }
}
