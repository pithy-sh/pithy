// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The closed axes of the support model — the ones that are genuinely fixed, as opposed to the
 * taxonomy in `categories.ts`, which is federated because every app has its own vocabulary.
 *
 * Priority and sentiment are not federated on purpose. A category answers *what is this*, and that
 * question has as many answers as there are products. Priority answers *how fast*, and sentiment
 * answers *who is about to churn* — both are questions about the sender, not about the product, so a
 * fourth priority level or a fifth sentiment would describe the same reality with more words.
 */

/** How fast a thread needs a human. */
export const SupportPriority = z
  .enum(["urgent", "normal", "low"])
  .describe("How fast this thread needs a human: `urgent` today, `normal` this week, `low` when there is time.");
export type SupportPriority = z.infer<typeof SupportPriority>;

/** How the sender sounds. The churn signal, not a politeness score. */
export const SupportSentiment = z
  .enum(["angry", "frustrated", "neutral", "positive"])
  .describe(
    "How the sender sounds — the churn signal. `angry` and `frustrated` are the ones worth sorting an inbox by.",
  );
export type SupportSentiment = z.infer<typeof SupportSentiment>;

/** Which way a message travelled. */
export const SupportMessageDirection = z
  .enum(["inbound", "outbound"])
  .describe("`inbound` arrived from the customer; `outbound` is a reply this Worker sent on the send path.");
export type SupportMessageDirection = z.infer<typeof SupportMessageDirection>;

/**
 * The category every taxonomy carries, whatever else it declares, and the value a classification
 * falls back to.
 *
 * It exists so "the model was unsure" is a first-class answer rather than a guess. A text model will
 * always produce *a* label, and a plausible-sounding invented one silently poisons every filter
 * downstream — so an out-of-taxonomy answer lands here instead.
 */
export const UNCATEGORIZED = "uncategorized";

/**
 * The one other category key the code names directly, because a behaviour hangs off it: a thread the
 * classifier calls spam is archived on sight when `guard.archiveSpam` is on.
 *
 * Naming it here rather than inline keeps the string in one place — an adopter may reword the
 * *description* the model reads, but the key is the join between the taxonomy and that behaviour.
 */
export const SPAM = "spam";
