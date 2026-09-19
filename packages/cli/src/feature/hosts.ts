// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import { workflowHostName, workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";

/**
 * **The kit Workers a feature stands up for itself (#643): email's, and so far only email's.**
 *
 * A feature's app Worker dispatches its magic links, OTP codes and every other message into email's send
 * Workflow, and that Workflow lives in email's host Worker — so a feature with no email host of its own signs
 * nobody in. `pithy provision --feature` therefore deploys a feature-scoped email host the way a declared
 * environment gets its own, through the same resolver and the same gated deploy (`project/deployKit.ts`), and
 * `pithy feature destroy` deletes it by the name it recomputes.
 *
 * The other hosts — media, storage, payments and the rest — are not stood up for a feature yet. Their resolvers
 * compose no feature names, and `deployKitWorkers` refuses a host whose name is not the feature's rather than
 * deploy one every branch would share. Adding one here is adding it to all three steps at once.
 */
export const FEATURE_HOSTS: readonly string[] = ["email"];

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

/**
 * The `workflows` entries one Worker needs for the hosts this scope stands up: every `workflow` binding its
 * composed capabilities **require**, named for the scope.
 *
 * Required, not every job a capability owns: email's scheduler is self-fired by its host's cron, and an app
 * Worker that bound it would bind a Workflow it must never start. The names come from the scope's
 * {@link ProvisionScope.workflowHost}, through the same two composers the host's own config is resolved with,
 * so the binding and the Workflow it reaches cannot be named twice.
 */
export function hostedWorkflowEntries(
  capabilities: readonly Capability[],
  scope: ProvisionScope,
  hosted: readonly string[] = FEATURE_HOSTS,
): HostedWorkflowEntry[] {
  const entries: HostedWorkflowEntry[] = [];
  for (const capability of capabilities) {
    if (!hosted.includes(capability.name)) continue;
    const required = new Set(
      capability.requiredBindings.filter((binding) => binding.type === "workflow").map((binding) => binding.name),
    );
    for (const entry of Object.values(composeWorkflows([capability]))) {
      const className = entry.spec.className;
      if (!required.has(entry.spec.binding) || className === undefined) continue;
      entries.push({
        binding: entry.spec.binding,
        name: workflowScriptName({ ...scope.workflowHost, capability: capability.name, job: entry.job }),
        class_name: className,
        script_name: workflowHostName({ ...scope.workflowHost, capability: capability.name }),
      });
    }
  }
  return entries;
}
