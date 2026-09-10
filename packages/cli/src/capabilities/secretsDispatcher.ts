// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type {
  PreflightSecretDispatcher,
  SecretProbe,
  SecretRotationRecorder,
} from "@pithy-sh/secrets/src/cli/dispatch";
import { WorkflowSecretDispatcher } from "@pithy-sh/secrets/src/manager/dispatcher";
import { cloudflareWorkflows } from "../cloudflare/clients";

/**
 * Build the live secrets dispatcher every value-touching command writes through — the manager
 * write-Workflow over the CF Workflows REST API, keyed by the canonical `<project>-<env>-secrets-write`
 * Workflow name. Shared by `pithy secrets`, `pithy turnstile`, `pithy storage`, and `pithy media` so the
 * dispatch wiring lives in exactly one place.
 *
 * `project` is the root `pithy.config.ts` `name` via `requireProjectName`, never a guess. Workflow names
 * are account-scoped: a wrong project here dispatches this project's secret values into another
 * project's manager, which encrypts and stores them under a master key this project cannot read.
 *
 * It is also the {@link SecretProbe} — the read seam provisioning asks before it mints anything — and the
 * {@link SecretRotationRecorder}, the rotation ledger `pithy secrets rotate` opens a row in before it rolls
 * (`#379`). All three contracts land on the same Workflow, so the same one object answers them, and a
 * caller cannot end up probing or recording against one project's manager while writing to another's.
 *
 * And it is a {@link PreflightSecretDispatcher}: the refusals a `d1` write owns — no manager to reach, an
 * `update` of a secret that is not there — are askable before a rotator is called, over the same Workflow
 * and the same store (#517).
 */
export async function buildSecretDispatcher(
  accountId: string,
  apiToken: string,
  project: string,
): Promise<PreflightSecretDispatcher & SecretProbe & SecretRotationRecorder> {
  return new WorkflowSecretDispatcher(await cloudflareWorkflows({ accountId, apiToken }), project);
}
