// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * What the organization purge's own steps retry, and what they refuse to (#623) — the policy `@pithy-sh/auth`'s
 * purge states for a user's, for the same reasons.
 *
 * The purge's own steps — reading whether the organization is due, the final record — and the daily pass's are D1,
 * and core answers for D1's transient vocabulary through `withD1Retry`. There is no `organization/*` code a second
 * attempt can answer differently, so the record is empty. **A capability's erase step is not classified here**: it
 * runs another capability's code, or the adopter's, and every `erase` is idempotent by contract, so `./run.ts`
 * hands those steps to the platform's own retry. **The cron is the outer retry.**
 */
export const organizationWorkflowRetry: WorkflowRetryPolicy = {
  capability: "organization",
  retryable: {},
};
