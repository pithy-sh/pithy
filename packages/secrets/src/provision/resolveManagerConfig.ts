// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { DeclaredEnvironments } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { SECRETS_CAPABILITY, secretsRotateWorkflowName, secretsWriteWorkflowName } from "../manager/dispatcher";
import { type ManagedEnvironment, managedEnvironments } from "../scope";
import { managerCfApiTokenSecretName, masterKeySecretName } from "./provisionSecrets";

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
  /**
   * The project name (root `pithy.config.ts` `name`, via `requireProjectName` — never guessed). Every
   * name in the resolved config leads with it: the Worker script, its D1, both Workflows, and both
   * Secrets Store entries. It is also stamped into the worker as the `PROJECT` var, so the at-rest
   * rotation writes its new key set back to the entry this worker actually binds.
   */
  project: string;
}

/**
 * One project's manager for one environment — `<project>-<env>-secrets`. It is three things at once:
 * the deployed Worker script name, the resolved config's basename, and the `database_name` of that
 * environment's secrets D1 (the manager and its database are one unit, so they share one name).
 *
 * **This is the sharpest project-scoping case in the toolset.** A Worker script name is account-scoped
 * and `wrangler deploy` upserts: unscoped, a second Pithy project's `pithy secrets provision` does not
 * collide with the first — it silently *replaces* the first project's running secrets manager, pointing
 * it at the second project's D1 and master key. Every subsequent write and rotation for the first
 * project then lands in, or fails against, resources it does not own. The D1 name shares the same flat
 * namespace and the same fate.
 *
 * Named as a **Worker script** through core's facade, so it is held to 63 — the workers.dev cap, the
 * only one that survives an adopter enabling a subdomain — rather than to the Workflow's 64 the two
 * numbers used to share. The database takes the same string deliberately: the manager and its D1 are
 * one unit, and a D1 name is the looser of the two limits, so the tighter one governs both.
 */
export function managerWorkerName(project: string, env: ManagedEnvironment): string {
  return resourceNames(project).env(env).worker(SECRETS_CAPABILITY);
}

/**
 * The deployed name behind one of the manager's Workflow bindings.
 *
 * Derived from the binding, never from the template's own `name`. The template says
 * `pithy-secrets-write`, and no amount of suffixing recovers a project from that — so, exactly like
 * every other capability's host resolver, the name is composed from `(project, capability, job, env)`
 * and the template's literal is documentation. An unrecognized binding is an authoring bug: it would
 * deploy a Workflow under a name nothing dispatches to, so it fails loudly here.
 */
function managerWorkflowName(binding: string, project: string, env: ManagedEnvironment): string {
  switch (binding) {
    case "SECRETS_WRITE":
      return secretsWriteWorkflowName(project, env);
    case "AT_REST_ROTATION":
      return secretsRotateWorkflowName(project, env);
    default:
      throw new InternalError({
        message: "The secrets manager template declares a Workflow provisioning cannot name.",
        action: "Give the binding a project-scoped name in resolveManagerConfig, or drop it from the template.",
        detail: `unresolved workflows binding: ${binding}`,
      });
  }
}

/**
 * Resolve the manager `wrangler.jsonc` template into one environment's standalone config — no
 * `[env.*]` stanzas (CLAUDE.md: staging and prod are genuinely separate workers). The template
 * carries `<filled-at-provision>` placeholders; this fills the project-scoped worker and Workflow
 * names, the D1 id and name, the Secrets Store id and entry names, and the account id, leaving every
 * static field untouched. Pure: the caller parses the template and writes the result.
 *
 * Every name it composes leads with the project, and every one goes through core's naming facade under
 * its own kind — a Worker script for the host, a Workflow for each job, a Secrets Store entry for each
 * bound secret — rather than suffixing the template's own literals, which carry no project to suffix.
 * Picking the kind is what picks the limit; no call here passes a budget.
 */
export function resolveManagerConfig(
  template: ManagerWranglerTemplate,
  params: ManagerConfigParams,
): ManagerWranglerTemplate {
  const { env, databaseId, storeId, accountId, project } = params;
  const name = managerWorkerName(project, env);
  const resolved: ManagerWranglerTemplate = structuredClone(template);

  resolved.name = name;
  resolved.d1_databases = resolved.d1_databases.map((db) => ({ ...db, database_name: name, database_id: databaseId }));
  // Both secrets live in the one account-wide store, so every entry gets `storeId` — and **every**
  // entry name is resolved here, never passed through. The template's literals are placeholders: an
  // entry name provisioning did not write is an entry the worker cannot bind, so an unrecognized
  // binding is an authoring bug and fails loudly rather than deploying a worker that dies on first read.
  resolved.secrets_store_secrets = resolved.secrets_store_secrets.map((entry) => ({
    ...entry,
    store_id: storeId,
    secret_name: managerStoreEntryName(entry.binding, project, env),
  }));
  // The write Workflow's name is the CLI's dispatch target (<project>-<env>-secrets-write). Both are
  // composed from the binding, so two projects' managers are addressable separately in one account.
  resolved.workflows = resolved.workflows.map((wf) => ({ ...wf, name: managerWorkflowName(wf.binding, project, env) }));
  resolved.vars = {
    ...resolved.vars,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    SECRETS_STORE_ID: storeId,
    ENVIRONMENT: env,
    PROJECT: project,
  };

  return resolved;
}

/**
 * The Secrets Store entry name behind one of the manager's store bindings. The master key is
 * per-environment; the CF API token is `global`. Both are project-scoped, because the account has
 * one flat Secrets Store and the name is the only partition in it.
 */
function managerStoreEntryName(binding: string, project: string, env: ManagedEnvironment): string {
  switch (binding) {
    case "SECRETS_ENCRYPTION_KEYS":
      return masterKeySecretName(project, env);
    case "CLOUDFLARE_API_TOKEN":
      return managerCfApiTokenSecretName(project);
    default:
      throw new InternalError({
        message: "The secrets manager template declares a Secrets Store binding provisioning never writes.",
        action: "Give the binding a project-scoped entry name in resolveManagerConfig, or drop it from the template.",
        detail: `unresolved secrets_store_secrets binding: ${binding}`,
      });
  }
}

/**
 * Resolve the manager config for every declared environment, given each env's provisioned ids.
 *
 * An environment with no entry in `perEnv` is skipped rather than resolved against `undefined` ids: the
 * ids are what provisioning produced, so a gap means that environment was not provisioned, and writing a
 * manager config with an empty `database_id` would deploy a manager bound to nothing.
 */
export function resolveAllManagerConfigs(
  template: ManagerWranglerTemplate,
  account: { accountId: string; project: string },
  perEnv: Record<ManagedEnvironment, { databaseId: string; storeId: string }>,
  environments: DeclaredEnvironments | readonly string[],
): Array<{ env: ManagedEnvironment; config: ManagerWranglerTemplate }> {
  const resolved: Array<{ env: ManagedEnvironment; config: ManagerWranglerTemplate }> = [];
  for (const env of managedEnvironments(environments)) {
    const ids = perEnv[env];
    if (!ids) continue;
    resolved.push({ env, config: resolveManagerConfig(template, { env, ...account, ...ids }) });
  }
  return resolved;
}
