// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the daily pass retries, and what it refuses to.**
 *
 * The pass reads activity, advances state, writes one snapshot per cohort, and enqueues nudges. All of
 * that is D1: a nudge is a row in `pithy_email_jobs`, and the send Workflow it dispatches afterwards is
 * the email capability's problem rather than this one's. So there is no `testers/*` code a second
 * attempt can answer differently, and the record is empty on purpose (pithy-sh/pithy#348).
 *
 * **An empty record is a statement, not an omission.** Core answers for D1's transient vocabulary
 * through `withD1Retry` — busy, timed out, connection lost, storage reset, internal — so a database
 * under contention is still re-driven, and nothing about that is restated here. What the empty record
 * adds is that testers retries none of its own codes.
 *
 * ## Terminal, and why
 *
 * - **`testers/cohort_closed`** — the pass refusing to send from a finished program. That is the
 *   refusal *working*: a closed cohort keeps its history and sends nothing further, and it does not
 *   reopen because the step asked again.
 * - **`testers/cohort_not_found`, `testers/member_not_found`** — a cohort or member deleted between the
 *   enumeration step and the cohort's own step. Deletion is not undone by a backoff, and this is exactly
 *   the case one-step-per-cohort exists to contain: the missing cohort loses its snapshot, the other
 *   cohorts keep theirs.
 * - **`testers/not_configured`** — no sending identity, no base URL. Config, and identical next time.
 * - **`testers/roster_full`, `testers/already_on_roster`, `testers/withdrawn`, `testers/invalid_token`,
 *   `testers/nudge_cooldown`, `testers/copy_not_allowed`** — every one belongs to a control-plane
 *   request or a tester's own click. The pass raises none of them.
 * - **`validation/invalid_input`** — a `TestersDailyParams` an operator dispatched by hand.
 *
 * **The cron is the outer retry, and the pass is contained per cohort.** A cohort whose step fails loses
 * its own day rather than everyone's, and the day after that runs again. Five platform attempts against
 * a closed cohort would spend the pass's budget re-asking a question whose answer is a person's or an
 * adopter's decision.
 *
 * **What this cannot say.** A `EMAIL_SENDER.create` that fails throws whatever the Workflows binding
 * threw — not a `PithyError`, so `unclassified`, so terminal. The job row is already written and
 * `pending`, and the email scheduler's grace re-drive claims a `pending` job whose dispatch died, so the
 * nudge is not lost; it is late. That is the correct outcome, but it is a default rather than a decision
 * and no policy record can turn it into one.
 */
export const testersWorkflowRetry: WorkflowRetryPolicy = {
  capability: "testers",
  retryable: {},
};
