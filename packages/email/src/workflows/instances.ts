// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The half of the Workflows binding that answers about an instance already created.
 *
 * Declared here rather than taken from `cloudflare:workers` because the scheduler must not depend on
 * the platform types — it takes a question as a function, and only the host answers it with a real
 * Workflow. It lives in its own module rather than beside that host because `workflows/worker.ts`
 * imports `cloudflare:workers` and so cannot be loaded under node, while
 * {@link ./hostEnv.ts} — which `pithy doctor` imports — has to be.
 */
export interface SendWorkflowInstances {
  /** Look an instance up by the id it was created with. Rejects when no such instance exists. */
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}
