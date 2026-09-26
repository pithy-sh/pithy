// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import {
  assertFeatureSlugFits,
  type FeatureHead,
  type FeatureIdentity,
  type FeatureNameShape,
  parseFeatureName,
} from "@pithy-sh/core/src/naming/feature";
import { NAMESPACE_LIMITS, type Namespace } from "@pithy-sh/core/src/naming/limits";
import { featureScope, type ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import { secretsWriteWorkflowName } from "@pithy-sh/secrets/src/manager/dispatcher";
import { masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { resolveWorkersFor } from "../project/composeFor";
import { loadProject, requireProjectName } from "../project/config";
import { projectCapabilities } from "../project/workerScope";
import { provisionWorkerNames } from "../provision/environment";
import { boundSecretNames, workerSecretRegistry } from "../provision/secretBindings";
import { provisionableBindings } from "./bindings";
import { featureHostCapabilities, featureHostScripts, featureIndexesFor } from "./hosts";

/**
 * **How long a branch slug a project's features can carry (#643).**
 *
 * Feature names are never truncated: a truncated slug was a short hash, and a hash is a slug some sibling branch
 * can have whole. So the slug has to fit every name the feature composes — every resource, Worker, kit host,
 * Workflow, store entry and index — and the one that leaves it least room sets the project's maximum.
 *
 * **Composed, not recounted.** Each name is composed by the namer provisioning uses, for a one-character probe slug,
 * and read back: the part after the slug is what the name carries, and its namespace's cap is what it is held to.
 * A second count of those parts here would be a second answer to what a feature is called.
 */

/** The probe every shape is composed with: the shortest legal slug. */
const PROBE_SLUG = "a";

/** Everything the budget is read from: what the branch composes, and its Workers. */
export interface FeatureNameSources {
  /** The project and issue. */
  head: FeatureHead;
  /** Every capability the feature spans. */
  capabilities: readonly Capability[];
  /** The project's Workers, by directory and deploy name. */
  workers: readonly ProvisionWorkerNames[];
  /** The project root, where a vector host's indexes are read from. */
  projectDir: string;
}

/** Every name the feature composes, as a shape: the namespace it goes into, and what follows the slug. */
export async function featureNameShapes(sources: FeatureNameSources): Promise<FeatureNameShape[]> {
  const probe: FeatureIdentity = { ...sources.head, slug: PROBE_SLUG };
  const scope = featureScope(probe);
  const shapes = new Map<string, FeatureNameShape>();
  const add = (namespace: Namespace, name: string): void => {
    const parsed = parseFeatureName(name);
    if (parsed === null) {
      throw new InternalError({
        message: "A feature name did not parse back.",
        detail: `${name} was composed for ${probe.project} #${probe.issue} and is not a feature name.`,
      });
    }
    const { label, maxLength } = NAMESPACE_LIMITS[namespace];
    shapes.set(`${namespace}:${parsed.thing}`, { label, limit: maxLength, thing: parsed.thing });
  };

  for (const { binding, kind } of provisionableBindings(sources.capabilities)) {
    add("r2", scope.resource(binding, kind, {}));
  }
  for (const worker of sources.workers) add("worker", scope.worker(worker));
  // Every registry host, composed or not: teardown names them all.
  for (const host of featureHostScripts(probe)) add("worker", host.script);
  // **Every Workflow the branch composes, whoever owns it (#650).** This read the registry host first, so only
  // a capability owning a kit Worker contributed a shape — and the app's own jobs own no host, because their
  // classes are exported by the app's own `main`. A branch whose slug fitted every kit name and not the app's
  // was therefore accepted here and refused by `composeFeatureName` at provision time, after the resources it
  // had already created. A Workflow name is account-wide whichever script hosts it; the budget asks only that.
  for (const capability of sources.capabilities) {
    for (const entry of Object.values(composeWorkflows([capability]))) {
      add("workflow", workflowScriptName({ ...scope.workflowHost, capability: capability.name, job: entry.job }));
    }
  }
  const registry = workerSecretRegistry(sources.capabilities);
  if (registry) {
    for (const secret of boundSecretNames(registry)) {
      const entry = registry[secret];
      if (entry) add("secretEntry", scope.secretEntry(secret, entry.scope));
    }
  }
  if (featureHostCapabilities(sources.capabilities).includes("secrets")) {
    add("secretEntry", masterKeySecretName(probe.project, FEATURE_ENVIRONMENT, probe));
    add("workflow", secretsWriteWorkflowName(probe.project, FEATURE_ENVIRONMENT, probe));
  }
  for (const index of await featureIndexesFor(sources.capabilities, sources.projectDir, probe)) {
    add("vectorizeIndex", index.name);
  }
  return [...shapes.values()];
}

/**
 * **Refuse a branch whose slug does not fit every name its feature composes**, naming the project's maximum.
 * `pithy provision --feature` asks it before anything is created.
 */
export async function assertFeatureSlugFitsSources(
  identity: FeatureIdentity,
  sources: Omit<FeatureNameSources, "head">,
): Promise<void> {
  assertFeatureSlugFits(identity, await featureNameShapes({ ...sources, head: identity }));
}

/**
 * **The same refusal, from a project directory** — what `pithy feature create` asks before it cuts a branch or a
 * worktree. Read from the checkout it runs in, which is the one the branch is cut from.
 */
export async function assertFeatureSlugFitsProject(
  projectDir: string,
  branch: Pick<FeatureIdentity, "issue" | "slug">,
): Promise<void> {
  const project = requireProjectName(await loadProject(projectDir));
  const workers = await resolveWorkersFor(FEATURE_ENVIRONMENT, { projectDir });
  await assertFeatureSlugFitsSources(
    { project, ...branch },
    {
      capabilities: projectCapabilities(workers),
      workers: workers.map(provisionWorkerNames),
      projectDir,
    },
  );
}
