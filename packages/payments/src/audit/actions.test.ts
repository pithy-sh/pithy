// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AuditAction } from "@pithy-sh/core/src/audit/auditEvent";
import { describe, expect, test } from "vitest";
import { PaymentsAuditActions } from "./actions";

describe("PaymentsAuditActions", () => {
  test("every code is a legal federated action", () => {
    // The recorder parses `action` against this, so a code that fails here fails at emit time — inside a
    // seam that is non-fatal by contract, which means the event would simply never be recorded.
    for (const action of Object.values(PaymentsAuditActions)) {
      expect(AuditAction.safeParse(action).success, action).toBe(true);
    }
  });

  test("every code is namespaced to payments, matching the migration namespace and error domain", () => {
    for (const action of Object.values(PaymentsAuditActions)) expect(action.startsWith("payments/")).toBe(true);
  });

  test("no two keys share a code", () => {
    const codes = Object.values(PaymentsAuditActions);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("the subscription lifecycle writes (#465)", () => {
  test("a plan change, a cancellation, and the withdrawal of one are three separate actions", () => {
    // Three acts, three codes. A pane reconstructing a dispute needs to see that a cancellation was
    // asked for AND that it was taken back; collapsing the withdrawal into an outcome on the cancel
    // event leaves the trail asserting a cancellation with nothing anywhere saying it was undone.
    expect(PaymentsAuditActions.subscriptionPlanChanged).toBe("payments/subscription_plan_changed");
    expect(PaymentsAuditActions.subscriptionCanceled).toBe("payments/subscription_canceled");
    expect(PaymentsAuditActions.subscriptionCancelWithdrawn).toBe("payments/subscription_cancel_withdrawn");
  });

  test("a refund request is its own act, separate from the cancellation it usually follows", () => {
    // Canceling and asking for money back are separate acts, often minutes apart and sometimes by
    // different actors. Folded together, a trail that says "canceled" is read as also saying "refunded",
    // and the request that has no other record anywhere becomes invisible.
    expect(PaymentsAuditActions.subscriptionRefundRequested).toBe("payments/subscription_refund_requested");
    expect(PaymentsAuditActions.subscriptionRefundRequested).not.toBe(PaymentsAuditActions.subscriptionCanceled);
  });

  test("the cancellation and its withdrawal are not the same code", () => {
    expect(PaymentsAuditActions.subscriptionCancelWithdrawn).not.toBe(PaymentsAuditActions.subscriptionCanceled);
  });

  test("the writes do not reuse the management read's code", () => {
    // `subscriptions_read` is a control-plane read of the same rows. A write that borrowed it would be
    // invisible in exactly the query an operator runs to find who changed somebody's billing.
    const writes = [
      PaymentsAuditActions.subscriptionPlanChanged,
      PaymentsAuditActions.subscriptionCanceled,
      PaymentsAuditActions.subscriptionCancelWithdrawn,
      PaymentsAuditActions.subscriptionRefundRequested,
    ];
    for (const write of writes) expect(write).not.toBe(PaymentsAuditActions.subscriptionsRead);
  });
});

describe("the naming scheme", () => {
  test("every key spells its own code — the camelCase key is the snake_case reason, verbatim", () => {
    // Not a rule read off its own subject: the key is what call sites type and the string is what
    // lands in `pithy_audit_events`, and the two are written independently. Drift between them is a
    // row nobody ever finds, because the operator greps the name the code calls it.
    for (const [key, code] of Object.entries(PaymentsAuditActions)) {
      const reason = key.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);
      expect(code, key).toBe(`payments/${reason}`);
    }
  });
});
