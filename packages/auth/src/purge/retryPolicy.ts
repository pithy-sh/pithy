// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What the purge's own steps retry, and what they refuse to** (#622).
 *
 * The purge's own steps — reading whether the account is due, the last mail, the final record — and the daily
 * pass's are D1, and core answers for D1's transient vocabulary through `withD1Retry`. There is no `auth/*`
 * code a second attempt can answer differently, so the record is empty, and that is a statement: an account
 * that is not due, or a binding that is not there, is the same answer next time.
 *
 * **A capability's erase step is not classified here, deliberately.** It runs the contribution's own code —
 * another capability's, or the adopter's — whose fault vocabulary the kit cannot know, and the contract makes
 * every `erase` idempotent precisely so that any fault in it can be retried. So the purge hands those steps to
 * the platform's own retry, with its backoff: a failing contribution retries alone, and the steps that finished
 * are served from the journal. That is the classification, stated at its one site, `./run.ts`.
 *
 * **The cron is the outer retry.** A pass whose `start` step fails is run again the next day, and a purge whose
 * instance failed is started again for the account still past its window.
 */
export const authWorkflowRetry: WorkflowRetryPolicy = {
  capability: "auth",
  retryable: {},
};
