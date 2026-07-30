// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ManagedEnvironment, managedEnvironments } from "../scope";
import { masterKeySecretName } from "./provisionSecrets";

/**
 * The manager's `wrangler.jsonc` template shape — only the fields provisioning resolves. The
 * committed template (`src/manager/wrangler.jsonc`) is the source of truth for the static fields
 * (compatibility date, crons, class names); this resolver fills the per-environment placeholders.
 */
export interface ManagerWranglerTemplate {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  /** Off — the manager has no public URL (Workflow dispatch + cron only). Passed through unchanged. */
  workers_dev: boolean;
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  secrets_store_secrets: Array<{ binding: string; store_id: string; secret_name: string }>;
  workflows: Array<{ binding: string; name: string; class_name: string }>;
  triggers: { crons: string[] };
  vars: Record<string, string>;
}

/** The resolved resource ids for one environment's manager deploy. */
export interface ManagerConfigParams {
  env: ManagedEnvironment;
  databaseId: string;
  storeId: string;
  accountId: string;
}

/** The manager worker name for an environment — also its deployed Worker name and config basename. */
export function managerWorkerName(env: ManagedEnvironment): string {
  return `pithy-secrets-${env}`;
}

/**
 * Resolve the manager `wrangler.jsonc` template into one environment's standalone config — no
 * `[env.*]` stanzas (CLAUDE.md: staging and production are genuinely separate workers). The template
 * carries `<filled-at-provision>` placeholders; this fills the per-env name, D1 id, Secrets Store id,
 * account id, and env-suffixed Workflow names, leaving every static field untouched. Pure: the caller
 * parses the template and writes the result.
 */
export function resolveManagerConfig(
  template: ManagerWranglerTemplate,
  params: ManagerConfigParams,
): ManagerWranglerTemplate {
  const { env, databaseId, storeId, accountId } = params;
  const name = managerWorkerName(env);
  const resolved: ManagerWranglerTemplate = structuredClone(template);

  resolved.name = name;
  resolved.d1_databases = resolved.d1_databases.map((db) => ({ ...db, database_name: name, database_id: databaseId }));
  // Both secrets live in the same store, so every entry gets `storeId`. Only the master key is
  // env-scoped — its entry name is env-prefixed. The CF API token is `global` (one fixed entry name,
  // bound the same way by both managers), so its `secret_name` passes through from the template.
  resolved.secrets_store_secrets = resolved.secrets_store_secrets.map((entry) => ({
    ...entry,
    store_id: storeId,
    secret_name: entry.binding === "SECRETS_ENCRYPTION_KEYS" ? masterKeySecretName(env) : entry.secret_name,
  }));
  // The write Workflow's name is the CLI's dispatch target (pithy-secrets-write-<env>); suffix every
  // Workflow so staging and production are addressable, and never collide, in one account.
  resolved.workflows = resolved.workflows.map((wf) => ({ ...wf, name: `${wf.name}-${env}` }));
  resolved.vars = { ...resolved.vars, CLOUDFLARE_ACCOUNT_ID: accountId, SECRETS_STORE_ID: storeId, ENVIRONMENT: env };

  return resolved;
}

/** Resolve the manager config for every managed environment, given each env's provisioned ids. */
export function resolveAllManagerConfigs(
  template: ManagerWranglerTemplate,
  accountId: string,
  perEnv: Record<ManagedEnvironment, { databaseId: string; storeId: string }>,
): Array<{ env: ManagedEnvironment; config: ManagerWranglerTemplate }> {
  return managedEnvironments().map((env) => ({
    env,
    config: resolveManagerConfig(template, { env, accountId, ...perEnv[env] }),
  }));
}
