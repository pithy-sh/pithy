// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the reconciliation pass retries, and what it refuses to.**
 *
 * The pass already draws this line in prose — `reconcile.ts` §"What a failure means" — and the line was
 * the right one: a store that cannot be *reached* fails the page so the step re-drives it, and every
 * other refusal is about one purchase and is counted rather than thrown. What was missing is that the
 * platform never heard it, so anything that did escape a page was retried on the same terms
 * (pithy-sh/pithy#338). This is that paragraph, in the form the step reads.
 *
 * ## Retryable
 *
 * - **`payments/provider_unavailable`** — Apple, Google, Stripe, Paddle or Lemon Squeezy unreachable, out
 *   of time, rate-limiting, or answering 5xx; every rail's HTTP layer folds those into this one code. A
 *   page is idempotent — it re-asks and re-projects to the same place — so a re-drive costs a request and
 *   fixes an outage that has since ended.
 * - **`core/upstream_failed` / `core/upstream_timeout`** — the same fault, raised by a shared client
 *   rather than by a rail.
 * - **A transient D1 fault** — classified in core by `withD1Retry`, never restated here.
 *
 * ## Terminal
 *
 * Everything else, and the list is deliberately not enumerated: an unmapped store state, a SKU no longer
 * in the catalog, a rail switched off since the row was written, a receipt that will not verify, a
 * parameter that will not validate. None of them answer differently to the same question an hour later,
 * and a pass that spends its retry budget on one of them is a pass that does not reach page forty-one.
 */
export const paymentsWorkflowRetry: WorkflowRetryPolicy = {
  capability: "payments",
  retryable: {
    "payments/provider_unavailable":
      "The store could not be reached. A page is idempotent, so re-asking is free and the outage may be over.",
    "core/upstream_failed": "A dependency this pass does not control was unreachable; the next attempt may reach it.",
    "core/upstream_timeout": "A dependency ran out of time rather than refusing; the same page can be asked again.",
  },
};
