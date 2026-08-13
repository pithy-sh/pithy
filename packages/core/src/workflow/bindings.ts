// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "../capability/bindings";
import type { RegisteredWorkflow, WorkflowSpec, WorkflowSpecMap } from "./spec";

/**
 * The one derivation from a durable job to the `workflow` binding that job needs.
 *
 * **Every capability that owns a Workflow wrote this by hand, and six of them wrote it wrong.**
 * `Object.values(map).map((spec) => ({ type: "workflow", name: spec.binding, optional: spec.optional }))`
 * appeared verbatim in payments, storage, support, vector, testers and media, and once more in
 * `createBackend`. It drops two fields, and dropping them is not cosmetic: `project/bindingEntries.ts`
 * needs `job` to compose the deployed Workflow's name and `className` to emit `class_name`, refuses to
 * write a partial `workflows` entry because wrangler rejects one, and returns `undefined` instead. So
 * `pithy upgrade` reported adding five bindings it had silently declined to write, and `pithy doctor`
 * — run seconds later against the same tree — correctly still called them missing (#318).
 *
 * **The `job` is the map key.** That is the whole reason `Object.values` was the wrong iterator: the
 * field the writer needs most is the one a values-only walk cannot see. `Object.entries` is not a
 * detail to remember at six call sites; it is this function.
 *
 * `className` rides through as declared — a spec may honestly omit it, for a job whose host config is
 * hand-maintained — and `capabilities/requiredBindings.test.ts` is what turns an omission that reaches
 * a shipped manifest into a build failure rather than a binding nothing writes.
 */
export function workflowBinding(job: string, spec: WorkflowSpec): BindingSpecInput {
  return {
    type: "workflow",
    name: spec.binding,
    job,
    ...(spec.className === undefined ? {} : { className: spec.className }),
    optional: spec.optional ?? false,
  };
}

/**
 * Every binding a capability's durable jobs require, derived from the job map itself.
 *
 * What a capability's `requiredBindings` spreads, so the declaration is one line that cannot lose a
 * field. A binding rename, a new job, or a class rename travels from the spec to `wrangler.jsonc`
 * without anything in between being edited.
 */
export function workflowBindings(workflows: WorkflowSpecMap): BindingSpecInput[] {
  return Object.entries(workflows).map(([job, spec]) => workflowBinding(job, spec));
}

/**
 * The same derivation from a {@link RegisteredWorkflow} — a spec already resolved against the
 * capability that declared it, which is the shape `createBackend`'s composed registry holds.
 *
 * It exists so the assembly-time derivation and the capability-time one are the same function rather
 * than the same four lines twice. `entry.job` is the registry's own copy of the map key, so the
 * binding it derives is byte-identical to the one the capability declared.
 */
export function registeredWorkflowBinding(entry: RegisteredWorkflow): BindingSpecInput {
  return workflowBinding(entry.job, entry.spec);
}
