// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import { InternalError } from "../error/pithyError";
import { workflowKey } from "./naming";
import type { RegisteredWorkflow, WorkflowRegistry } from "./spec";

/**
 * Registration: every capability's `workflows` map merged into one project-wide registry keyed
 * `<capability>/<job>`. The peer of `composeDatabases` and `composeKv`, and deliberately simpler —
 * a job belongs to exactly one capability, so there is no cross-capability merge to arbitrate,
 * only a duplicate to reject.
 */

/**
 * Merge every capability's declared jobs into one registry. A capability declaring the same job
 * name twice is impossible (it is a map key); two capabilities colliding is impossible (the key is
 * capability-namespaced). What remains is one real conflict — the same capability `name` composed
 * twice — which is an assembly-time author error, caught here rather than surfacing as a job that
 * silently dispatches to the wrong binding.
 */
export function composeWorkflows(capabilities: readonly Capability[]): WorkflowRegistry {
  const registry: WorkflowRegistry = {};
  for (const capability of capabilities) {
    for (const [job, spec] of Object.entries(capability.workflows ?? {})) {
      const key = workflowKey(capability.name, job);
      if (key in registry) {
        throw new InternalError({
          message: `Duplicate workflow "${key}".`,
          action: "Compose each capability once — two capabilities are registering the same name.",
          detail: `The capability "${capability.name}" is composed more than once, or two capabilities share the name.`,
        });
      }
      registry[key] = { key, capability: capability.name, job, spec };
    }
  }
  return registry;
}

/** Every registered job carrying a cron — what `createEntrypoint` fires on a `scheduled` event. */
export function scheduledWorkflows(registry: WorkflowRegistry): RegisteredWorkflow[] {
  return Object.values(registry).filter((entry) => entry.spec.schedule !== undefined);
}
