// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SupportPriority, SupportSentiment, UNCATEGORIZED } from "./enums";

/**
 * One conversation in `pithy_support_threads` — the row the inbox is a list of.
 *
 * **Everything on it is derived from immutable inbound mail.** The classification is recomputed, never
 * repaired; the user link is a lookup, not a decision; the counters are facts about the messages
 * below. There is no assignee and no status, because a status field is a state machine and a state
 * machine attracts SLAs, escalation, and reporting — which is a ticketing product and explicitly not
 * this. The two exceptions are deliberate and named: `archived` (one shared boolean meaning done) and
 * the per-viewer flags, which live in their own table because nobody coordinates around them.
 *
 * The classification axes are **denormalized onto the thread** rather than joined from
 * `pithy_support_classifications`. The whole dashboard interaction is "newest first, filtered by
 * category and priority and archived", and that is a composite-index workload — a join to find the
 * latest classification per thread would make the one query this table exists to serve the expensive
 * one. The classification table keeps the history; this keeps the answer.
 */
export const SupportThread = z
  .object({
    id: z
      .string()
      .describe(
        "UUID primary key. Text, not autoincrement, because a thread id reaches a dashboard and an enumerable inbox is an enumerable customer list.",
      ),
    inboxAddress: z
      .string()
      .describe(
        "The support address this thread arrived on, lowercased. Stored per thread so one Worker can serve several inboxes (support@, security@) and the dashboard can filter by which.",
      ),
    subject: z
      .string()
      .describe(
        "The subject of the message that opened the thread. Later replies never rewrite it — the thread keeps its name.",
      ),
    fromAddress: z
      .string()
      .describe(
        "The sender's address, lowercased. The join key for the user link, the sender history, and the volume guard — so it is normalized on the way in, once.",
      ),
    fromName: z
      .string()
      .nullish()
      .describe(
        "The sender's display name from the `From` header, when they had one. Untrusted text; render it escaped.",
      ),
    senderAuthenticated: SQLiteBoolean.describe(
      "Whether the `From:` header was proved to belong to the sender — DMARC passed, or SPF passed on an aligned domain. **False does not mean forged**, it means unproven, which is the common case for a domain publishing no DMARC policy. It gates the customer link: an unproven sender is never decorated with somebody's real purchase history, because that is what turns a spoofed message into support-driven account takeover.",
    ),
    userId: z
      .string()
      .nullish()
      .describe(
        "The `pithy_auth_users.id` this sender resolves to, or null when the address belongs to nobody with an account — or when the sender was not authenticated, because an unproven `From:` must not resolve to a real customer. Derived, so a customer who signs up later is linked by the next message rather than by a repair.",
      ),
    category: z
      .string()
      .describe(
        "The current category key, from this project's effective taxonomy. A plain string rather than an enum because the taxonomy is federated — the valid set is not known until an adopter composes the capability, so it is validated at the classification boundary instead of by the column.",
      ),
    priority: SupportPriority.describe("The current priority — how fast this thread needs a human."),
    sentiment: SupportSentiment.describe("The current sentiment — the churn signal."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .nullish()
      .describe(
        "The model's self-reported confidence in the current classification, 0..1. Null until a classification lands. Kept so a low-confidence inbox can be reviewed separately from a confident one.",
      ),
    model: z
      .string()
      .nullish()
      .describe(
        "The Workers AI model id that produced the current classification. Recorded so a reclassification pass after a model upgrade can tell which rows came from which model — the whole reason reclassification is possible at all.",
      ),
    classifiedAt: SQLiteDate.nullish().describe(
      "When the current classification was written; null until the Workflow has run.",
    ),
    archived: SQLiteBoolean.describe(
      "Done. One shared boolean, not per viewer, because if one person resolves a thread another should not still see it open. The mildest possible coordination state: no transitions to get wrong, nothing can be stuck, and unarchiving undoes a mistake instantly.",
    ),
    archivedAt: SQLiteDate.nullish().describe("When the thread was last archived; null while it is open."),
    archivedBy: z
      .string()
      .nullish()
      .describe(
        "The control-plane subject that archived it. Recorded for the dashboard's convenience only — the answer to 'who marked this done' comes from the audit trail, which is why this is not an ownership column.",
      ),
    messageCount: z.number().int().describe("How many messages the thread holds, inbound and outbound together."),
    firstMessageAt: SQLiteDate.describe("When the thread opened — the receive time of its first message."),
    lastMessageAt: SQLiteDate.describe(
      "When the thread last moved. The inbox sorts on this, and it is the `receivedAt` half of every composite index and of the pagination cursor.",
    ),
    createdAt: SQLiteDate.describe("When the thread row was created."),
    updatedAt: SQLiteDate.describe("When the thread row was last written."),
  })
  .describe("One support conversation in `pithy_support_threads` — derived entirely from the mail below it.");
export type SupportThread = z.output<typeof SupportThread>;

/** What a brand-new thread's classification columns hold before the Workflow has run. */
export const UNCLASSIFIED = {
  category: UNCATEGORIZED,
  priority: "normal",
  sentiment: "neutral",
  confidence: null,
  model: null,
  classifiedAt: null,
} as const satisfies Pick<
  SupportThread,
  "category" | "priority" | "sentiment" | "confidence" | "model" | "classifiedAt"
>;
