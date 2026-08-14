// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What a send retries, and what it refuses to.**
 *
 * Email already classified the *provider's* vocabulary — `errorMapping.ts` maps every `E_*` code the
 * Email Service returns to retryable or terminal, and says why. This is the other half: the same
 * decision in the form the durable step reads, covering the faults that never came from the binding at
 * all (pithy-sh/pithy#338).
 *
 * ## Retryable
 *
 * - **`email/rate_limited`** — the per-second or daily quota. The next window is a different answer.
 * - **`email/send_failed`** — raised by `runSend` **only** when `classifySendError` judged the code
 *   transient (`E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR`, or an unknown code getting its one
 *   bounded retry). A validation, sender, or content code takes the terminal branch there and never
 *   reaches a throw, which is why this entry is not the hole it looks like — and `retryPolicy.test.ts`
 *   holds the two classifications to each other rather than trusting this sentence.
 * - **A transient D1 fault** — the jobs, events and suppression tables. Classified in core.
 *
 * ## Terminal
 *
 * - **`core/not_found`** — the job row is gone. A send cannot invent the message it was asked to send,
 *   and a deleted row does not come back over a backoff.
 * - **`email/template_not_found`, `email/invalid_payload`** — a render that cannot be attempted twice
 *   with a different result.
 * - **Anything unclassified**, including a payload that will not parse.
 *
 * A suppressed recipient is neither: `runSend` records it and returns, because a person who asked not to
 * be mailed is an outcome rather than a failure.
 */
export const emailWorkflowRetry: WorkflowRetryPolicy = {
  capability: "email",
  retryable: {
    "email/rate_limited": "The send was over a rate or daily quota; the next window admits it.",
    "email/send_failed":
      "Only thrown for a code classifySendError judged transient — delivery, an upstream 5xx, or one bounded retry of an unknown code.",
  },
};
