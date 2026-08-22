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

/** Which way a message traveled. */
export const SupportMessageDirection = z
  .enum(["inbound", "outbound"])
  .describe("`inbound` arrived from the customer; `outbound` is a reply this Worker sent on the send path.");
export type SupportMessageDirection = z.infer<typeof SupportMessageDirection>;

/**
 * How a message reached this inbox.
 *
 * Closed for the same reason priority is: a channel is a *transport this capability implements*, not a
 * vocabulary an adopter brings — there is no third answer a project could need that the code would not
 * also have to be taught to speak. It is the axis the two halves of the capability differ on, and the
 * differences are real rather than cosmetic: `email` arrives at a public address from an unauthenticated
 * `From:` header, and `app` arrives on a request whose session was already proved.
 */
export const SupportChannel = z
  .enum(["email", "app"])
  .describe(
    "How this arrived: `email` at a configured inbound address, or `app` from a signed-in user of the adopter's own app. The axis the console filters on, and the one the account link's provenance follows from.",
  );
export type SupportChannel = z.infer<typeof SupportChannel>;

/**
 * How a thread came to name an account — the provenance of `userId`, and the distinction
 * `inbound/authenticity.ts` spends two hundred lines earning.
 *
 * A `From:` header is an unauthenticated claim, so an email thread's link is a *match on an address
 * anybody could have written*. An in-app submission has no `From:` to spoof: `requireAuth()` proved
 * the session before the handler ran, so the link is the identity rather than a guess about it.
 *
 * **A console must not render the two the same way.** They differ in exactly the situation that
 * matters — deciding whether to act on somebody's billing history — and a single boolean cannot say
 * which one it is looking at. `senderAuthenticated` answers *may we believe this*, and this answers
 * *how did we come to believe it*; the second is what an operator needs when the first is false and
 * there is still a name on the thread.
 */
export const SupportAccountLinkSource = z
  .enum(["session", "email_address"])
  .describe(
    "How this thread's `userId` was established: `session` means an authenticated request proved it, `email_address` means it was matched from the address in a `From:` header. Never equivalent — one is the identity, the other is a lookup on a claim.",
  );
export type SupportAccountLinkSource = z.infer<typeof SupportAccountLinkSource>;

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
 * The one other category key the code names directly, because a behavior hangs off it: a thread the
 * classifier calls spam is archived on sight when `guard.archiveSpam` is on.
 *
 * Naming it here rather than inline keeps the string in one place — an adopter may reword the
 * *description* the model reads, but the key is the join between the taxonomy and that behavior.
 */
export const SPAM = "spam";
