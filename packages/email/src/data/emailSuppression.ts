// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { SuppressionReason } from "./enums";

/**
 * One row in `pithy_email_suppressions` — an address that must not be sent to, fed by hard bounces,
 * complaints, and unsubscribes. The send path checks this list before every send and skips a match,
 * recording why. `z.output` is the app shape; `z.input` is the SQLite row.
 */
export const EmailSuppression = z
  .object({
    id: z.number().int().describe("Surrogate primary key, autoincremented by SQLite."),
    email: z.string().describe("The suppressed address, lowercased. Uniquely indexed — one row per address."),
    reason: SuppressionReason.describe(
      "Why the address is suppressed: hard bounce, complaint, unsubscribe, or manual.",
    ),
    jobId: z
      .string()
      .nullish()
      .describe(
        "The job that triggered the suppression (a bounce/complaint/unsubscribe), if any. Job ids are per-environment, so pair it with `environment` for context.",
      ),
    environment: z
      .string()
      .nullish()
      .describe(
        "The environment the triggering job came from (e.g. `prod`, `feature-27`). The suppression itself is global; this records where it originated.",
      ),
    detail: z
      .string()
      .nullish()
      .describe("Free-form context — the bounce code or complaint source; null when not applicable."),
    createdAt: SQLiteDate.describe("When the address was suppressed."),
    expiresAt: SQLiteDate.nullish().describe("When a temporary suppression lifts; null for a permanent suppression."),
  })
  .describe("One suppressed address in `pithy_email_suppressions`.");
export type EmailSuppression = z.output<typeof EmailSuppression>;
