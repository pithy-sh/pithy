// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * Which model embedded a message into the semantic index, in `pithy_support_embeddings`.
 *
 * **Its own table, not a column on the message**, for two reasons. The messages chain is released history, and
 * a stamp belongs to a derived index rather than to the mail: drop the index and every stamp is a lie, so they
 * go together, and nothing about a message changes. It is what `pithy vector reprocess --index
 * support-messages` reads to re-embed exactly the rows whose model differs from the configured one — the same
 * job `pithy_vector_documents.model` does for an index `vector()` owns.
 *
 * A message with no row was never embedded, which is the set a backfill and a repair both pick up.
 */
export const SupportEmbedding = z
  .object({
    messageId: z
      .string()
      .describe("The `pithy_support_messages.id` this stamp is for — also the vector's id in the index."),
    model: z.string().describe("The Workers AI embedding model that produced the vector now in the index."),
    embeddedAt: SQLiteDate.describe("When the vector was written."),
  })
  .describe("The model stamp for one message's vector in the semantic index.");
export type SupportEmbedding = z.output<typeof SupportEmbedding>;
