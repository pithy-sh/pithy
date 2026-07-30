// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { secretsWriteWorkflowName, WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";

/**
 * Build the live secrets dispatcher every value-touching command writes through — the manager
 * write-Workflow over the CF Workflows REST API, keyed by the canonical per-environment Workflow name.
 * Shared by `pithy secrets` and `pithy turnstile` so the dispatch wiring lives in exactly one place.
 */
export function buildSecretDispatcher(accountId: string, apiToken: string): SecretDispatcher {
  return new WorkflowSecretDispatcher(new CloudflareWorkflowsClient({ accountId, apiToken }), secretsWriteWorkflowName);
}
