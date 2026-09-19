// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type FeatureIdentity, featureNamePrefix } from "@pithy-sh/core/src/naming/feature";
import { featureScope, type ProvisionScope, type ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { workflowHostName, workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import { type FeatureIndex, HOST_WORKERS, hostWorkerFor } from "../capabilities/hostRegistry";

/**
 * **Every kit Worker a feature composes, stood up for the feature (#643).**
 *
 * A feature is an environment, and an environment runs the kit Workers its capabilities own: email's sender,
 * media's enrichment, storage's sweep, payments' reconcile, the secrets manager, and whatever the registry
 * (`capabilities/hostRegistry.ts`) names next. So `pithy provision --feature` deploys each composed host the way
 * `pithy deploy` ships a declared environment's — the same registry entry, the same resolver, the same gated
 * deploy (`project/deployKit.ts`) — with the feature handed in, so every name the host is called or binds is
 * the feature's own. `pithy feature destroy` deletes them by the names recomputed here.
 *
 * **There is no list of feature hosts, and that is the design.** The set is the registry intersected with what
 * the branch composes, read the same way `pithy dev` and `pithy deploy` read it, so a capability that gains a
 * host joins a feature with no change in this directory. Email was the first instance, not a special case.
 *
 * What a resolver must do for a feature is stated once, in {@link featureHostNameLeaks}: every account-wide name
 * in its config begins with the feature's prefix. A resolver that forgets the feature composes
 * `<project>-feature-…`, one Worker every open branch would share, and that host fails rather than deploys.
 */

/** The capabilities, of those composed, that own a kit host — in registry order, which is deploy order. */
export function featureHostCapabilities(capabilities: readonly Capability[]): string[] {
  const composed = new Set(capabilities.map((capability) => capability.name));
  return HOST_WORKERS.filter((spec) => composed.has(spec.capability)).map((spec) => spec.capability);
}

/**
 * The script name each registry host deploys under for this feature — **every** registry host, composed or not.
 *
 * Teardown reads it this way because a branch that composed payments last week and not today still has a
 * payments host deployed, and an exact name reaches nothing but this feature's. The collision refusal reads it
 * this way because an app Worker that takes a host's name today takes it from whichever capability is added next.
 */
export function featureHostScripts(identity: FeatureIdentity): { capability: string; script: string }[] {
  const scope = featureScope(identity);
  return HOST_WORKERS.map((spec) => ({
    capability: spec.capability,
    script: workflowHostName({ ...scope.workflowHost, capability: spec.capability }),
  }));
}

/**
 * **Refuse an app Worker whose feature script name is a kit host's.** `featureWorkerName(identity, "email")` is
 * both `apps/email`'s feature name and email's feature host: one would deploy over the other, and teardown could
 * not tell them apart. A declared environment has no such collision because an app's name there is its own
 * `wrangler.jsonc` `name`. Checked against every registry host, for the reason {@link featureHostScripts} gives.
 */
export function assertNoFeatureHostCollision(
  identity: FeatureIdentity,
  workers: readonly ProvisionWorkerNames[],
): void {
  const scope = featureScope(identity);
  const hosts = new Map(featureHostScripts(identity).map((host) => [host.script, host.capability]));
  for (const worker of workers) {
    const script = scope.worker(worker);
    const capability = hosts.get(script);
    if (capability === undefined) continue;
    throw new ValidationError({
      message: `apps/${worker.app} would deploy as ${script}, the name this feature's ${capability} host takes.`,
      action: `Rename apps/${worker.app}. A feature names each Worker by its directory, and ${capability} is a kit host's.`,
      detail: `feature ${identity.project}-f${identity.issue}-${identity.slug}: app ${worker.app} and the ${capability} host both compose ${script}`,
    });
  }
}

/** One cross-script `workflows` entry on an app Worker: its binding, into a host Worker's Workflow. */
export interface HostedWorkflowEntry {
  /** The binding name the app Worker's env exposes, e.g. `EMAIL_SENDER`. */
  binding: string;
  /** The deployed Workflow name in this scope. */
  name: string;
  /** The `WorkflowEntrypoint` class the host exports. */
  class_name: string;
  /** The host Worker the class lives in, in this scope. */
  script_name: string;
}

/** A {@link HostedWorkflowEntry}, with the capability whose host it reaches — what decides whether it is written. */
export interface OwnedHostedWorkflowEntry extends HostedWorkflowEntry {
  /** The capability that owns the host this entry binds into. */
  capability: string;
}

/**
 * The `workflows` entries one Worker needs into the kit hosts of this scope: every `workflow` binding its
 * composed capabilities **declare**, for each capability that owns a host, named for the scope.
 *
 * Declared, not every job a capability owns: email's scheduler is self-fired by its host's cron, and an app
 * Worker that bound it would bind a Workflow it must never start. The names come from the scope's
 * {@link ProvisionScope.workflowHost}, through the same two composers the host's own config is resolved with,
 * so the binding and the Workflow it reaches cannot be named twice.
 */
export function hostedWorkflowEntries(
  capabilities: readonly Capability[],
  scope: ProvisionScope,
): OwnedHostedWorkflowEntry[] {
  const entries: OwnedHostedWorkflowEntry[] = [];
  for (const capability of capabilities) {
    if (hostWorkerFor(capability.name) === undefined) continue;
    const declared = new Set(
      capability.requiredBindings.filter((binding) => binding.type === "workflow").map((binding) => binding.name),
    );
    for (const entry of Object.values(composeWorkflows([capability]))) {
      const className = entry.spec.className;
      if (!declared.has(entry.spec.binding) || className === undefined) continue;
      entries.push({
        capability: capability.name,
        binding: entry.spec.binding,
        name: workflowScriptName({ ...scope.workflowHost, capability: capability.name, job: entry.job }),
        class_name: className,
        script_name: workflowHostName({ ...scope.workflowHost, capability: capability.name }),
      });
    }
  }
  return entries;
}

/**
 * **Every account-wide name in a resolved host config that is not this feature's** — empty when the resolver
 * named everything for the feature.
 *
 * The script, each Workflow, each R2 bucket, each Vectorize index and each Secrets Store entry: each is one
 * account-wide namespace, so each must begin with {@link featureNamePrefix}. **No exception for a `global`
 * entry**: nothing is shared between a feature and any other environment, so even the secrets manager's CF API
 * token is the feature's own. D1 databases and KV namespaces are bound by id, and every id a feature host binds is
 * read off the feature's own generated stanza — the gate in `feature/isolation.test.ts` follows each id to the
 * resource behind it.
 */
export function featureHostNameLeaks(config: WorkflowHostTemplate, identity: FeatureIdentity): string[] {
  const prefix = featureNamePrefix(identity);
  const leaks: string[] = [];
  const check = (name: string | undefined): void => {
    if (name !== undefined && !name.startsWith(prefix)) leaks.push(name);
  };
  check(config.name);
  for (const entry of config.workflows ?? []) check(entry.name);
  for (const entry of config.r2_buckets ?? []) check(entry.bucket_name);
  for (const entry of config.vectorize ?? []) check(entry.index_name);
  for (const entry of config.secrets_store_secrets ?? []) check(entry.secret_name);
  return leaks;
}

/**
 * **Every index the composed hosts bind that the feature creates for itself** — each host's own
 * `featureIndexes`, named for the feature (#643). Asked of the registry rather than of any one capability, so a
 * host that binds a new kind of index joins with its own entry.
 */
export async function featureIndexesFor(
  capabilities: readonly Capability[],
  projectDir: string,
  identity: FeatureIdentity,
): Promise<FeatureIndex[]> {
  const indexes: FeatureIndex[] = [];
  for (const capability of capabilities) {
    const spec = hostWorkerFor(capability.name);
    if (spec?.featureIndexes) indexes.push(...(await spec.featureIndexes(capability, projectDir, identity)));
  }
  return indexes;
}
