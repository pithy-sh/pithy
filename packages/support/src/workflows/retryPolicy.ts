// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What a classification retries, and what it refuses to.**
 *
 * `ai/classify.ts` already drew this line and drew it correctly: a model that returns prose, an invented
 * label, or an envelope nobody documented yields `uncategorized` at zero confidence and never throws,
 * because throwing would burn a retry budget on a model that is going to say the same thing next time.
 * The one case it deliberately does not swallow is a binding that is *unavailable*. This is that
 * sentence in the form the durable step reads (pithy-sh/pithy#348).
 *
 * ## Retryable, and why
 *
 * - **`core/upstream_failed`** — Workers AI rejected the call. Raised at exactly one place, the wrap
 *   around `ai.run` in `classifyMessage`, and it means the model did not answer at all. That is the
 *   whole population of transient faults in a classification, and the code is what lets the step tell
 *   it from a bad answer — a raw throw would be `unclassified`, and unclassified is terminal.
 * - **A transient D1 fault** — the message read, the appended history row, the thread denormalization.
 *   Classified in core by `withD1Retry`, never restated here.
 *
 * ## Terminal, and why
 *
 * - **`support/not_found`** — a thread or message that is gone. `runClassification` does not even raise
 *   it for the message it was started for: a missing row returns `null`, because an instance outliving
 *   the row that started it is the ordinary way a rollback looks.
 * - **`support/classification_failed`** — the AI binding is absent from the env. A binding does not
 *   appear on the fourth attempt; this wants `pithy support provision`.
 * - **`support/invalid_category`** — the adopter's taxonomy will not validate. Config, and identical
 *   next time.
 * - **`support/unparseable_message`, `support/rejected`, `support/reply_failed`** — all inbound-path and
 *   reply-path refusals. None runs inside the classify step.
 * - **`validation/invalid_input`** — a payload the schema refuses.
 *
 * **Re-running is free, which is what makes the retryable entry safe.** Classification is idempotent by
 * construction: a second pass appends a second history row and overwrites the same three thread columns
 * with a fresh judgment, which is why a Workflow retry, a manual reclassify, and a post-upgrade
 * backfill are the same operation.
 */
export const supportWorkflowRetry: WorkflowRetryPolicy = {
  capability: "support",
  retryable: {
    "core/upstream_failed":
      "The model did not answer at all; classification is idempotent, so asking again costs one call.",
  },
};
