// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { AUDIT_RESOURCE_TYPE } from "../provision/resources";

/** One environment's host Workflows, as a capability teardown deletes them. */
export interface HostWorkflowDeletion {
  /** The account's Workflows client. Only the delete is used: the names are recomputed, never scanned. */
  workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  /** The account this deletes from, and what vouches for it (#378). */
  account: ConfirmedAccount;
  /** The capability whose host ran them — the audit action's domain. */
  capability: string;
  /** The one environment being torn down. */
  env: ManagedEnvironment;
  /** Every Workflow the host was deployed with, from the capability's own namer. */
  names: readonly string[];
  /** Audit emitter. One event per Workflow this run deleted. */
  audit: CliAuditEmit;
}

/**
 * **Delete a capability host's Workflows by name (#789).** Deleting a Worker does not delete the Workflows
 * registered against it, so every capability teardown that removes a host calls this first. The names come
 * from the capability's namer — the same call its resolved `wrangler.jsonc` was filled from — so this cannot
 * reach another project's Workflows, or another environment's.
 *
 * Idempotent: a Workflow already gone answers `false` from the client and is skipped, unaudited. Refused on an
 * unconfirmed account before any delete, because a miss there is no evidence of anything. Resolves the names
 * this run deleted.
 */
export async function deleteHostWorkflows(deletion: HostWorkflowDeletion): Promise<string[]> {
  const { workflows, account, capability, env, names, audit } = deletion;
  const deleted: string[] = [];
  for (const name of names) {
    // The lookup is the delete: the client answers whether the Workflow was there. `findOnConfirmedAccount`
    // never calls it on an unconfirmed account, so the refusal comes before anything is changed.
    const gone = await findOnConfirmedAccount({
      ...account,
      what: `the ${name} Workflow`,
      find: async () => ((await workflows.deleteWorkflow(name)) ? name : null),
    });
    if (gone === null) continue;
    deleted.push(gone);
    await audit({
      environment: env,
      action: `${capability}/workflow_deleted`,
      outcome: "success",
      severity: "warning",
      resourceType: AUDIT_RESOURCE_TYPE.workflow,
      resourceId: gone,
    });
  }
  return deleted;
}
