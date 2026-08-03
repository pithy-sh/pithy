// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { SecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";

/**
 * Build the live secrets dispatcher every value-touching command writes through — the manager
 * write-Workflow over the CF Workflows REST API, keyed by the canonical `<project>-<env>-secrets-write`
 * Workflow name. Shared by `pithy secrets`, `pithy turnstile`, `pithy storage`, and `pithy media` so the
 * dispatch wiring lives in exactly one place.
 *
 * `project` is the root `pithy.config.ts` `name` via `requireProjectName`, never a guess. Workflow names
 * are account-scoped: a wrong project here dispatches this project's secret values into another
 * project's manager, which encrypts and stores them under a master key this project cannot read.
 */
export function buildSecretDispatcher(accountId: string, apiToken: string, project: string): SecretDispatcher {
  return new WorkflowSecretDispatcher(new CloudflareWorkflowsClient({ accountId, apiToken }), project);
}
