// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type FeatureIdentity, featureResourceName, isFeatureOwnedName } from "@pithy-sh/core/src/naming/feature";
import { featureScope, type ProvisionScope, type ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import type { WorkflowHostTemplate } from "@pithy-sh/core/src/workflow/host";
import { workflowHostName, workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import { type FeatureIndex, HOST_WORKERS, hostWorkerFor } from "../capabilities/hostRegistry";
import type { ResourceProvisioners } from "../provision/resources";
import { provisionableBindings } from "./bindings";

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
 * What a resolver must do for a feature is stated once, in {@link featureHostNameLeaks}: every binding in its
 * config reaches something the feature owns. A resolver that forgets the feature composes
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
 * The resources a feature owns that a config can only name by id — its D1 databases and KV namespaces, id → the
 * name each was created under. Read off the feature's manifest (`featureOwnedIds`), whose entries are honored only
 * when their names recompute for this feature.
 */
export interface FeatureOwnedIds {
  /** D1 database id → name. */
  d1: ReadonlyMap<string, string>;
  /** KV namespace id → title. */
  kv: ReadonlyMap<string, string>;
}

/**
 * **The feature's own D1 databases and KV namespaces, asked of the account (#643)** — each binding the composed
 * capabilities declare, named for the feature and looked up by that name. The account, never a file: a manifest
 * is repository content, and an id read out of one is an id anyone could have written there.
 */
export async function featureOwnedIds(
  provisioners: Pick<ResourceProvisioners, "d1" | "kv">,
  identity: FeatureIdentity,
  capabilities: readonly Capability[],
): Promise<FeatureOwnedIds> {
  const d1 = new Map<string, string>();
  const kv = new Map<string, string>();
  for (const { binding, kind } of provisionableBindings(capabilities)) {
    if (kind !== "d1" && kind !== "kv") continue;
    const name = featureResourceName(identity, binding, kind);
    const found = await provisioners[kind].find(name);
    if (found) (kind === "d1" ? d1 : kv).set(found.id, name);
  }
  return { d1, kv };
}

/**
 * Keys a Worker config carries that name no account resource: settings, code, or a service Cloudflare runs for
 * the whole account that no environment owns a copy of (Workers AI, Email Sending). Every other key is walked.
 */
const NOT_A_RESOURCE = new Set([
  "$schema",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "workers_dev",
  "triggers",
  "observability",
  "ai",
  "send_email",
  "build",
  "assets",
  "placement",
  "limits",
  "minify",
  "keep_vars",
  "upload_source_maps",
  "rules",
  "no_bundle",
  "find_additional_modules",
]);

/**
 * **Every binding in a resolved host config that is not this feature's** — empty when the resolver named
 * everything for the feature (#643).
 *
 * Every key the config carries is walked, and a key this cannot classify is itself a leak, so a binding kind
 * added tomorrow is refused until it is classified. Each binding is followed to the thing it reaches and that
 * thing must be the feature's, by {@link isFeatureOwnedName}: parsed back to its project, issue **and slug**, so
 * a sibling branch of the same issue is not the feature. A D1 database or KV namespace is bound by id, so the id
 * is followed to the name it was created under through `owned`; an id the feature did not create is a leak,
 * whatever `database_name` label sits beside it. A route is always one: a feature answers on its own `workers.dev` address.
 */
export function featureHostNameLeaks(
  config: WorkflowHostTemplate | Record<string, unknown>,
  identity: FeatureIdentity,
  owned: FeatureOwnedIds = { d1: new Map(), kv: new Map() },
): string[] {
  const leaks: string[] = [];
  const own = (what: string, name: unknown): void => {
    if (typeof name !== "string" || !isFeatureOwnedName(identity, name)) leaks.push(`${what}: ${String(name)}`);
  };
  const byId = (what: string, ids: ReadonlyMap<string, string>, id: unknown): void => {
    // No id yet — absent, empty or a template's `<placeholder>` — is provisioning that has not run, which the
    // readiness check refuses in its own words. It names no resource, so it cannot be anybody else's.
    if (id === undefined || String(id).trim() === "" || /^<.+>$/.test(String(id).trim())) return;
    const name = ids.get(String(id));
    if (name === undefined) leaks.push(`${what}: id ${String(id)} is not one this feature created`);
    else own(what, name);
  };
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (NOT_A_RESOURCE.has(key)) continue;
    switch (key) {
      case "name":
        own("script", value);
        break;
      case "route":
        leaks.push(`route: ${JSON.stringify(value)}`);
        break;
      case "routes":
        for (const route of list(value)) leaks.push(`route: ${JSON.stringify(route)}`);
        break;
      case "d1_databases":
        // By id alone: wrangler binds the id, and a `database_name` beside it is a label nothing reads.
        for (const entry of list(value)) byId(`d1 ${String(entry.binding)}`, owned.d1, entry.database_id);
        break;
      case "kv_namespaces":
        for (const entry of list(value)) byId(`kv ${String(entry.binding)}`, owned.kv, entry.id);
        break;
      case "r2_buckets":
        for (const entry of list(value)) own(`r2 ${String(entry.binding)}`, entry.bucket_name);
        break;
      case "vectorize":
        for (const entry of list(value)) own(`vectorize ${String(entry.binding)}`, entry.index_name);
        break;
      case "services":
        for (const entry of list(value)) own(`service ${String(entry.binding)}`, entry.service);
        break;
      case "workflows":
        for (const entry of list(value)) {
          own(`workflow ${String(entry.binding)}`, entry.name);
          if (entry.script_name !== undefined) own(`workflow ${String(entry.binding)} script`, entry.script_name);
        }
        break;
      case "secrets_store_secrets":
        for (const entry of list(value)) own(`store entry ${String(entry.binding)}`, entry.secret_name);
        break;
      case "durable_objects":
        for (const entry of list((value as { bindings?: unknown } | undefined)?.bindings)) {
          if (entry.script_name !== undefined) own(`durable object ${String(entry.name)}`, entry.script_name);
        }
        break;
      case "queues":
        for (const entry of [
          ...list((value as { producers?: unknown } | undefined)?.producers),
          ...list((value as { consumers?: unknown } | undefined)?.consumers),
        ]) {
          own(`queue ${String(entry.binding ?? "consumer")}`, entry.queue);
        }
        break;
      case "analytics_engine_datasets":
        for (const entry of list(value)) own(`dataset ${String(entry.binding)}`, entry.dataset);
        break;
      default:
        leaks.push(`unclassified key ${key}`);
    }
  }
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
