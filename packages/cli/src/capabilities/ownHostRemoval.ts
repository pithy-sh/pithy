// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { hostWorkflowsFor } from "@pithy-sh/core/src/workflow/host";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";
import { AUDIT_RESOURCE_TYPE } from "../provision/resources";
import { hostOwnerFor, hostWorkerFor } from "./hostRegistry";
import { deleteHostWorkflows } from "./hostWorkflows";

/** One environment's own host of a Worker: its script and every Workflow it was deployed with. */
export interface OwnHostNames {
  /** The `apps/<owner>` directory name the host is named for. */
  owner: string;
  /** The host's Worker script, `<project>-<env>-<owner>---<capability>`. */
  script: string;
  /** Every Workflow the host registers, self-fired ones included, named for the owner. */
  workflows: string[];
}

/**
 * **The host a Worker has to itself for a capability, by the names its deploy used** — or `undefined` when the
 * Worker owns nothing that capability's host binds, and so shares the host every other Worker reaches.
 *
 * Composed from the capability object, through the same two composers the deployed host's config is resolved with,
 * so the names cannot differ from what is on the account.
 */
export function ownHostNames(
  project: string,
  env: ManagedEnvironment,
  capability: Capability,
  worker: { dir: string; ownBindings?: readonly string[] },
): OwnHostNames | undefined {
  const spec = hostWorkerFor(capability.name);
  if (spec === undefined) return undefined;
  const owner = hostOwnerFor(spec, capability, worker, { refuseSplit: false })?.worker;
  if (owner === undefined) return undefined;
  const parts = { project, capability: capability.name, env, owner };
  return {
    owner,
    script: workflowHostName(parts),
    workflows: hostWorkflowsFor(composeWorkflows([capability]), parts).workflows.map((workflow) => workflow.name),
  };
}

/** What {@link deleteOwnHosts} reaches the account with, and what it deletes. */
export interface OwnHostDeletion {
  project: string;
  /** The capability being removed from the Worker. */
  capability: Capability;
  /** The Worker it is removed from: its directory and the bindings it owns. */
  worker: { dir: string; ownBindings?: readonly string[] };
  /** Every deployed environment the project declares. The host is the Worker's in each of them. */
  environments: readonly ManagedEnvironment[];
  account: ConfirmedAccount;
  workers: Pick<ReturnType<CloudflareClients["workers"]>, "getWorker" | "deleteWorker">;
  workflows: Pick<CloudflareWorkflowsClient, "deleteWorkflow">;
  /** The audit emitter for one environment. One event per Worker and Workflow deleted. */
  audit: (env: ManagedEnvironment) => Promise<CliAuditEmit>;
}

/** One host {@link deleteOwnHosts} deleted. */
export interface DeletedOwnHost {
  env: ManagedEnvironment;
  script: string;
}

/**
 * **Delete the Worker's own host for the capability, and its Workflows, in every declared environment.** Nothing but
 * that Worker reaches its own host, so once the capability is unwired from it the host serves no one. The shared host
 * is never touched: other Workers still reach it.
 *
 * Workflows first, because deleting a Worker leaves the Workflows registered against it. Idempotent: a host already
 * gone is skipped, unaudited. Every lookup is settled on a confirmed account, so an unconfirmed one refuses before
 * anything is deleted. Resolves the hosts this run deleted.
 */
export async function deleteOwnHosts(deletion: OwnHostDeletion): Promise<DeletedOwnHost[]> {
  const deleted: DeletedOwnHost[] = [];
  for (const env of deletion.environments) {
    const names = ownHostNames(deletion.project, env, deletion.capability, deletion.worker);
    if (names === undefined) return deleted;
    const audit = await deletion.audit(env);
    await deleteHostWorkflows({
      workflows: deletion.workflows,
      account: deletion.account,
      capability: deletion.capability.name,
      env,
      names: names.workflows,
      audit,
    });
    const found = await findOnConfirmedAccount({
      ...deletion.account,
      what: `the ${names.script} Worker`,
      find: () => deletion.workers.getWorker(names.script),
    });
    if (!found) continue;
    await deletion.workers.deleteWorker(names.script);
    await audit({
      environment: env,
      action: `${deletion.capability.name}/worker_removed`,
      outcome: "success",
      severity: "warning",
      resourceType: AUDIT_RESOURCE_TYPE.worker,
      resourceId: names.script,
    });
    deleted.push({ env, script: names.script });
  }
  return deleted;
}
