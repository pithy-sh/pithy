// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { AUDIT_CHECKPOINT_BINDING } from "../chain/checkpoint";
import { AUDIT_CAPABILITY, auditWorkflowRegistry } from "../workflows/specs";

/**
 * Resolve the checkpoint host's committed `wrangler.jsonc` template into one environment's standalone config
 * (#822). Thin over core's {@link resolveWorkflowHost}: this file owns only which database the host reads, which
 * bucket it writes, and the Workflow names derived from audit's own specs.
 */

/**
 * The checkpoint bucket's name in a declared environment — **the name `pithy provision` gives the
 * `AUDIT_CHECKPOINTS` binding**, read through the very function it composes it with, so the host and the app
 * Worker cannot bind two different buckets.
 */
export function auditCheckpointBucketName(project: string, env: string): string {
  return environmentScope(project, env).resource(AUDIT_CHECKPOINT_BINDING, "r2", {});
}

/** The resolved resource ids and names for one environment's checkpoint host. */
export interface AuditConfigParams {
  /** The project name, from `requireProjectName` and never guessed. */
  project: string;
  /** The target environment. */
  env: string;
  /** The feature this host serves, when it serves one (#643). */
  feature?: FeatureIdentity;
  /** The audit database's id — the D1 behind the binding `audit({ database })` names. */
  auditDatabaseId: string;
  /** The checkpoint bucket's name. */
  bucketName: string;
}

/** Fill the template for one environment. */
export function resolveAuditConfig(template: WorkflowHostTemplate, params: AuditConfigParams): WorkflowHostTemplate {
  const { project, env, feature } = params;
  const derived = hostWorkflowsFor(auditWorkflowRegistry, {
    project,
    capability: AUDIT_CAPABILITY,
    env,
    ...(feature ? { feature } : {}),
  });
  const resolved = resolveWorkflowHost(template, {
    project,
    capability: AUDIT_CAPABILITY,
    env,
    ...(feature ? { feature } : {}),
    // The host always reads it as `DB`; which database that is follows the adopter's `audit({ database })`.
    databaseIds: { DB: params.auditDatabaseId },
    r2BucketNames: { [AUDIT_CHECKPOINT_BINDING]: params.bucketName },
    workflows: derived.workflows,
  });
  resolved.triggers = derived.crons.length > 0 ? { crons: derived.crons } : undefined;
  return resolved;
}
