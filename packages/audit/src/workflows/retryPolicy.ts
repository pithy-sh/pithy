// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * The checkpoint's retry policy: **no audit code is retried.** Core already re-drives a transient D1 fault, and an
 * R2 write that failed is re-attempted by the next hour's run, which checkpoints the head as it then stands. A run
 * that fails costs one hour of checkpoint coverage, never a checkpoint, because nothing is ever overwritten.
 */
export const auditWorkflowRetry: WorkflowRetryPolicy = {
  capability: "audit",
  retryable: {},
};
