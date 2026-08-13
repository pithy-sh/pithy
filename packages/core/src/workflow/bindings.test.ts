// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { BindingSpec } from "../capability/bindings";
import { registeredWorkflowBinding, workflowBinding, workflowBindings } from "./bindings";
import type { WorkflowSpecMap } from "./spec";

/**
 * **A binding derived from a job carries everything the writer needs to write it.**
 *
 * Stated over the derivation rather than over any capability, because six capabilities each carried
 * their own copy and the copies were what was wrong (#318). The fields under test are exactly the two
 * `project/bindingEntries.ts` refuses to emit a `workflows` entry without.
 */

const specs = {
  reconcile: {
    binding: "PAYMENTS_RECONCILE",
    className: "PaymentsReconcileWorkflow",
    params: z.object({}).describe("No parameters."),
    schedule: "0 4 * * *",
    optional: true,
  },
  send: {
    binding: "EMAIL_SENDER",
    className: "EmailSendWorkflow",
    params: z.object({}).describe("No parameters."),
  },
} as const satisfies WorkflowSpecMap;

describe("a job's binding carries what the writer needs", () => {
  test("the job is the map key, which a values-only walk cannot see", () => {
    expect(workflowBindings(specs)).toEqual([
      {
        type: "workflow",
        name: "PAYMENTS_RECONCILE",
        job: "reconcile",
        className: "PaymentsReconcileWorkflow",
        optional: true,
      },
      { type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow", optional: false },
    ]);
  });

  test("every derived binding parses, so a job name a deploy would refuse fails at the capability", () => {
    // `job` lands verbatim in the adopter's wrangler.jsonc as part of a Cloudflare Workflow name, and
    // `BindingSpec` holds it to `NAME_SEGMENT`. A map key that breaks the rule is refused here, named,
    // rather than reaching a config wrangler will not load.
    for (const binding of workflowBindings(specs)) expect(() => BindingSpec.parse(binding)).not.toThrow();
    expect(() => BindingSpec.parse(workflowBinding("Not A Segment", specs.reconcile))).toThrow(/one name segment/);
  });

  test("a spec that honestly declares no class derives no className, rather than an empty one", () => {
    const handMaintained = { binding: "HAND_ROLLED", params: z.object({}).describe("None.") };
    expect(workflowBinding("sweep", handMaintained)).toEqual({
      type: "workflow",
      name: "HAND_ROLLED",
      job: "sweep",
      optional: false,
    });
  });

  test("the registry derivation and the capability derivation are the same binding", () => {
    // `createBackend` derives from the composed registry and a capability derives from its own map.
    // Two derivations that disagree is how the app's fail-fast check and the CLI's writer came to
    // describe different bindings under the same name.
    expect(
      registeredWorkflowBinding({
        key: "payments/reconcile",
        capability: "payments",
        job: "reconcile",
        spec: specs.reconcile,
      }),
    ).toEqual(workflowBinding("reconcile", specs.reconcile));
  });
});
