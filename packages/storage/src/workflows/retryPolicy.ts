// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the orphan sweep retries, and what it refuses to.**
 *
 * The sweep reconciles D1 against R2, and it has already decided what a failure means: every delete and
 * every multipart abort is `.catch(() => {})` on purpose, because an object this run could not remove is
 * an object the next run finds again. That is a reconciler's contract — not error swallowing — and it is
 * what leaves this record empty (pithy-sh/pithy#348).
 *
 * **An empty record is a statement, not an omission.** Core answers for D1's transient vocabulary
 * through `withD1Retry`, so a database under contention is still re-driven by the step, and nothing
 * about that is restated here. What the empty record adds is that storage retries none of its *own*
 * codes.
 *
 * ## Terminal, and why
 *
 * - **`storage/*`** — every one of them is a *request's* refusal: a file that is not there, a file that
 *   is not yours, a quota, an upload that never finished, an expired share. The sweep raises none of
 *   them, and a sweep that somehow did has found a bug rather than an outage.
 * - **`validation/invalid_input`** — a `StorageSweepParams` an operator dispatched by hand. A payload
 *   parses the same way on the fifth attempt as on the first.
 * - **`secrets/*`** — the R2 credentials the multipart abort needs. A key that is not in the bound key
 *   set will not be in it a minute later; this wants `pithy secrets provision`, not a backoff.
 *
 * **The cron is the outer retry, and that is why terminal is cheap here.** The sweep is idempotent by
 * construction — a second pass over a reconciled bucket finds nothing left to do — so a run that fails
 * costs one day, and the next day's run does the whole job. Five platform attempts against a refusal
 * that cannot change cost the same day *and* bury the reason under four repeats of it.
 *
 * **What this cannot say, and it is worth knowing.** A bucket listing that fails mid-sweep throws
 * whatever the R2 binding threw, which is not a `PithyError` and carries no code — so it is
 * `unclassified`, which is terminal. That is the right default and the correct outcome here (the next
 * fire re-lists from the top), but it is a default rather than a decision, and no policy record can
 * turn it into one.
 */
export const storageWorkflowRetry: WorkflowRetryPolicy = {
  capability: "storage",
  retryable: {},
};
