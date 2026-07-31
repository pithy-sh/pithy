// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SupportPriority, SupportSentiment } from "./enums";

/**
 * One classification in `pithy_support_classifications` — append-only, one row per model run.
 *
 * The thread carries the *current* answer because that is what the inbox query needs; this carries
 * *every* answer, because a reclassification pass after a model upgrade has to be able to say which
 * rows came from which model and what changed. Append-only is what makes that a fact rather than a
 * reconstruction: nothing here is ever updated, and a wrong classification is superseded, not fixed.
 *
 * Confidence is the model's own self-report, which is worth exactly what a language model's
 * self-report is worth — useful for sorting a review queue, never for a gate.
 */
export const SupportClassification = z
  .object({
    id: z.string().describe("UUID primary key."),
    threadId: z.string().describe("The `pithy_support_threads.id` this classification was written against."),
    messageId: z
      .string()
      .describe(
        "The `pithy_support_messages.id` the model actually read. Recorded because a thread's classification is a judgement about one message, and knowing which one is what makes a disagreement between two runs legible.",
      ),
    category: z
      .string()
      .describe(
        "The category key the model chose, already validated against the effective taxonomy — an out-of-taxonomy answer never reaches this table, it becomes `uncategorized` first.",
      ),
    priority: SupportPriority.describe("The priority the model assigned."),
    sentiment: SupportSentiment.describe("The sentiment the model assigned."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "The model's self-reported confidence, 0..1. Bounded here rather than by a CHECK constraint: the schema is the table definition, and a model's answer is the one value in this table that originates outside our own code, so the bound belongs on the way in.",
      ),
    model: z
      .string()
      .describe(
        "The Workers AI model id that produced this row. The column the whole table exists for — without it a model upgrade is a silent rewrite of history.",
      ),
    createdAt: SQLiteDate.describe("When this classification was written."),
  })
  .describe("One append-only classification in `pithy_support_classifications` — what a model said, and which model.");
export type SupportClassification = z.output<typeof SupportClassification>;
