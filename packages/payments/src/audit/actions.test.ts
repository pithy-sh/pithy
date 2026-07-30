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
