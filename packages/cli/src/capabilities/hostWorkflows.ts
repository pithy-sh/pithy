// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { discoverWorkers } from "../project/workers";
import { AUDIT_RESOURCE_TYPE } from "../provision/resources";

/** One environment's host Workflows, as a capability teardown deletes them. */
export interface HostWorkflowDeletion {
  /** The account's Workflows client. Only the delete is used: the names are recomputed, never scanned. */
  workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  /** The account this deletes from, and what vouches for it. */
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
 * **Delete a capability host's Workflows by name.** Deleting a Worker does not delete the Workflows
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

/** What {@link ownedHostNames} composes from. */
export interface OwnedHostNaming {
  /** The capability whose host it is. */
  capability: string;
  /** The project, from `requireProjectName`. */
  project: string;
  /** The one environment being torn down. */
  env: ManagedEnvironment;
  /** The `apps/` Workers that may have deployed a host of their own: every Worker that lists `ownBindings`. */
  owners: readonly string[];
  /** The shared host's Workflows, from the capability's own namer: each is `<project>-<env>-<capability>-<job>`. */
  workflows: readonly string[];
}

/**
 * **The hosts a Worker had to itself, and their Workflows, by recomputed names.** A Worker that owns a binding its
 * capability's host binds is deployed a host named `<project>-<env>-<owner>---<capability>`, with the shared host's
 * jobs. Teardown deletes by exact name, so it asks for every owner's: one never deployed is not on the account, and
 * one too long to compose is refused at deploy, so it is skipped rather than aborting the teardown.
 */
export function ownedHostNames(naming: OwnedHostNaming): { workers: string[]; workflows: string[] } {
  const names = resourceNames(naming.project).env(naming.env);
  const prefix = `${names.worker(naming.capability)}-`;
  const jobs = naming.workflows.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  return {
    workers: naming.owners.flatMap((owner) => composable(() => names.worker(naming.capability, owner))),
    workflows: naming.owners.flatMap((owner) =>
      jobs.flatMap((job) => composable(() => names.workflow(naming.capability, job, owner))),
    ),
  };
}

/**
 * A name teardown recomputes, or none when the namer refuses it. A name the namer refuses is one no deploy could have
 * created, since every deploy composes through the same namer, so there is nothing on the account to delete under it.
 */
export function composable(compose: () => string): string[] {
  try {
    return [compose()];
  } catch (error) {
    if (error instanceof PithyError) return [];
    throw error;
  }
}

/** The shared host's script and every owner's, for a teardown that deletes each one the account has. */
export function hostScriptsOf(naming: Omit<OwnedHostNaming, "workflows">, shared: string): string[] {
  return [shared, ...ownedHostNames({ ...naming, workflows: [] }).workers];
}

/** The shared host's Workflows and every owner's, for {@link deleteHostWorkflows}. */
export function hostWorkflowsOf(naming: OwnedHostNaming): string[] {
  return [...naming.workflows, ...ownedHostNames(naming).workflows];
}

/** The `apps/` Workers a capability teardown asks for an own host of: every one listing `ownBindings`, by directory. */
export async function projectHostOwners(projectDir: string): Promise<string[]> {
  const workers = await discoverWorkers(projectDir);
  return workers.filter((worker) => (worker.ownBindings ?? []).length > 0).map((worker) => basename(worker.dir));
}
