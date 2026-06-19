import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { SecretDispatcher, SecretWriteRequest } from "../cli/dispatch";
import type { ManagedEnvironment } from "../scope";

/** Resolve the manager write-Workflow's name for an environment (each env's manager has its own). */
export type WorkflowNameForEnv = (env: ManagedEnvironment) => string;

/**
 * The canonical name of an environment's manager write-Workflow — the contract between the deployed
 * manager and every CLI dispatch site. Defined once here so a rename can't leave a caller dispatching
 * to a non-existent Workflow.
 */
export function secretsWriteWorkflowName(env: ManagedEnvironment): string {
  return `pithy-secrets-write-${env}`;
}

/**
 * The real {@link SecretDispatcher}: dispatches a write to the target environment's manager
 * write-Workflow over the CF Workflows REST API and polls to completion. This is the CLI's write
 * path — the master key is worker-only, so the CLI never encrypts or stores locally. The dispatched
 * params carry the (already validated) value, so failures never echo them (see the client).
 */
export class WorkflowSecretDispatcher implements SecretDispatcher {
  readonly #client: CloudflareWorkflowsClient;
  readonly #workflowName: WorkflowNameForEnv;

  constructor(client: CloudflareWorkflowsClient, workflowName: WorkflowNameForEnv) {
    this.#client = client;
    this.#workflowName = workflowName;
  }

  async dispatch(request: SecretWriteRequest): Promise<void> {
    await this.#client.dispatchAndPoll(this.#workflowName(request.env), {
      mode: request.mode,
      name: request.name,
      value: request.value,
      valueType: request.valueType,
      rotatable: request.rotatable,
    });
  }
}
