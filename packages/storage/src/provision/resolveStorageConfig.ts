import { hostWorkflowsFor, resolveWorkflowHost, type WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import type { StorageConfig } from "../config/config";
import { STORAGE_CAPABILITY, storageWorkflowRegistry } from "../workflows/specs";
import type { StorageResources } from "./provisionStorage";

/**
 * Resolve the sweep worker's committed `wrangler.jsonc` template into one environment's standalone
 * config. Every per-environment decision lives here; everything static — the compatibility date, the
 * bindings' names — stays as the template committed it.
 *
 * Thin over core's {@link resolveWorkflowHost}, which owns the mechanics (clone, fill by binding name,
 * stamp `ENVIRONMENT`). What this file adds is one thing the generic resolver deliberately does not
 * do: it **rewrites `workflows` and `triggers.crons` from the capability's specs** rather than from
 * the template's own block. The template carries both so it reads as a complete, deployable config,
 * but `workflows/specs.ts` is the single source of the binding name, the class name, and the
 * schedule — so changing the sweep's cron is a one-line spec edit, not a spec edit plus a JSONC edit
 * that nothing checks agree.
 *
 * Pure: the caller parses the template and writes the result.
 */

/** The resolved ids and per-env values for one environment's sweep-worker deploy. */
export interface StorageConfigParams {
  /** The target environment. */
  env: ManagedEnvironment;
  /** The app database id for this environment — where the `pithy_storage_*` tables live. */
  appDatabaseId: string;
  /** This environment's secrets database id (`pithy-secrets-<env>`) — holds the R2 credentials. */
  secretsDatabaseId: string;
  /** The CF Secrets Store id holding the per-env master key. */
  storeId: string;
  /** The provisioned bucket the worker binds. */
  resources: StorageResources;
  /** The app's resolved storage config — serialized into the worker's `STORAGE_CONFIG` var. */
  storageConfig: StorageConfig;
}

/** Fill the template for one environment. */
export function resolveStorageConfig(
  template: WorkflowHostTemplate,
  params: StorageConfigParams,
): WorkflowHostTemplate {
  const { env, appDatabaseId, secretsDatabaseId, storeId, resources, storageConfig } = params;

  const resolved = resolveWorkflowHost(template, {
    capability: STORAGE_CAPABILITY,
    env,
    databaseIds: { DB: appDatabaseId, SECRETS: secretsDatabaseId },
    r2BucketNames: { STORAGE_BUCKET: resources.bucketName },
    secretsStoreId: storeId,
    // The master key entry is env-scoped — its name is env-prefixed, matching what the secrets manager wrote.
    masterKeySecretName: masterKeySecretName(env),
    vars: { STORAGE_CONFIG: JSON.stringify(storageConfig) },
  });

  const derived = hostWorkflowsFor(storageWorkflowRegistry, STORAGE_CAPABILITY, env);
  resolved.workflows = derived.workflows;
  // Only declare a cron block when a spec actually carries one. An empty `crons` array is a
  // declaration wrangler honours, and a worker that advertises a schedule it does not have is a
  // deployment nobody can reason about.
  resolved.triggers = derived.crons.length > 0 ? { crons: derived.crons } : undefined;

  return resolved;
}
