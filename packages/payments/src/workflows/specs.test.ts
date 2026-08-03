// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { describe, expect, test } from "vitest";
import { PAYMENTS_CAPABILITY, PaymentsReconcileParams, paymentsWorkflowRegistry, paymentsWorkflows } from "./specs";

describe("payments workflow specs", () => {
  test("declares one job, bound and classed for the prebuilt reconcile worker", () => {
    expect(Object.keys(paymentsWorkflows)).toEqual(["reconcile"]);
    expect(paymentsWorkflows.reconcile.binding).toBe("PAYMENTS_RECONCILE");
    expect(paymentsWorkflows.reconcile.className).toBe("PaymentsReconcileWorkflow");
  });

  test("the job is optional, so a project that has not provisioned still boots", () => {
    // Receipts, webhooks, and entitlement reads all work with no Workflow at all. A required binding would
    // make `pithy add payments` produce a Worker that refuses to start until an account has been touched.
    expect(paymentsWorkflows.reconcile.optional).toBe(true);
  });

  test("carries a daily cron, offset from the other hosts' 03:00 jobs", () => {
    expect(paymentsWorkflows.reconcile.schedule).toBe("0 4 * * *");
  });

  test("the registry keys on `payments/reconcile`, through core's own key builder", () => {
    expect(Object.keys(paymentsWorkflowRegistry)).toEqual(["payments/reconcile"]);
    expect(paymentsWorkflowRegistry["payments/reconcile"]?.capability).toBe(PAYMENTS_CAPABILITY);
  });

  test("the deployed name is the shape already on the wire for storage and media", () => {
    expect(resourceNames("acme").env("staging").workflow(PAYMENTS_CAPABILITY, "reconcile")).toBe(
      "acme-staging-payments-reconcile",
    );
  });

  test("empty params are valid — a cron supplies none, so a required field could never run", () => {
    expect(PaymentsReconcileParams.parse({})).toEqual({});
  });

  test("every field is optional, which is what makes the cron dispatch legal", () => {
    // Asserted over the shape rather than by one `parse({})`, so a field added later cannot quietly be
    // required and break the schedule instead of a test.
    for (const [name, field] of Object.entries(PaymentsReconcileParams.shape)) {
      expect(field.safeParse(undefined).success, `${name} must be optional`).toBe(true);
    }
  });

  test("a manual run may narrow to a user, a rail, the windows, and a dry run", () => {
    expect(
      PaymentsReconcileParams.parse({
        userId: "ada",
        rail: "apple",
        expiringWithinSeconds: 60,
        staleAfterSeconds: 120,
        pageSize: 5,
        maxPages: 2,
        dryRun: true,
      }),
    ).toEqual({
      userId: "ada",
      rail: "apple",
      expiringWithinSeconds: 60,
      staleAfterSeconds: 120,
      pageSize: 5,
      maxPages: 2,
      dryRun: true,
    });
  });

  test("a nonsense window or page size is refused at dispatch, not inside a running instance", () => {
    expect(PaymentsReconcileParams.safeParse({ expiringWithinSeconds: 0 }).success).toBe(false);
    expect(PaymentsReconcileParams.safeParse({ staleAfterSeconds: -1 }).success).toBe(false);
    expect(PaymentsReconcileParams.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(PaymentsReconcileParams.safeParse({ maxPages: -3 }).success).toBe(false);
  });

  test("a rail nobody implements is refused at dispatch", () => {
    expect(PaymentsReconcileParams.safeParse({ rail: "paddle" }).success).toBe(false);
  });
});
