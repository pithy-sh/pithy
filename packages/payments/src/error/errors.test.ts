// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload, PublicErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import {
  PaymentsEntitlementRequiredError,
  PaymentsEnvironmentMismatchError,
  PaymentsInvalidReceiptError,
  PaymentsProductNotFoundError,
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
  PaymentsVerificationFailedError,
  PaymentsWebhookUnverifiedError,
} from "./errors";

/** Every vehicle in the domain, with the status the union pins for it. */
const FAMILY = [
  { error: () => new PaymentsInvalidReceiptError(), code: "payments/invalid_receipt", status: 400 },
  { error: () => new PaymentsVerificationFailedError(), code: "payments/verification_failed", status: 400 },
  { error: () => new PaymentsWebhookUnverifiedError(), code: "payments/webhook_unverified", status: 401 },
  { error: () => new PaymentsRailNotConfiguredError(), code: "payments/rail_not_configured", status: 404 },
  { error: () => new PaymentsProductNotFoundError(), code: "payments/product_not_found", status: 404 },
  { error: () => new PaymentsEnvironmentMismatchError(), code: "payments/environment_mismatch", status: 400 },
  { error: () => new PaymentsReceiptAlreadyOwnedError(), code: "payments/receipt_already_owned", status: 409 },
  { error: () => new PaymentsProviderUnavailableError(), code: "payments/provider_unavailable", status: 503 },
  { error: () => new PaymentsEntitlementRequiredError(), code: "payments/entitlement_required", status: 403 },
] as const;

describe("payments error family", () => {
  test("every vehicle carries its code and the status core's union pins for it", () => {
    for (const { error, code, status } of FAMILY) {
      const thrown = error();
      expect(thrown.payload.code, code).toBe(code);
      expect(thrown.payload.status, code).toBe(status);
    }
  });

  test("every code is in the payments domain, which is what aligns it with the tables and migrations", () => {
    for (const { error } of FAMILY) expect(error().payload.code.startsWith("payments/")).toBe(true);
  });

  test("every code is registered in core's closed union, not merely well-formed", () => {
    // Against `KitErrorPayload`, not `ErrorPayload`: the latter is open at its edge for an adopter's
    // own codes, so a typo in a `payments/` code would parse there as somebody's custom error with a
    // free-floating status. The closed union is what makes this file a check rather than a claim.
    expect(() => FAMILY.map(({ error }) => KitErrorPayload.parse(error().payload))).not.toThrow();
  });

  test("detail never reaches a client — the public projection drops it", () => {
    const thrown = new PaymentsReceiptAlreadyOwnedError({
      detail: "transaction 2000000123456789 is owned by u1; u2 submitted it",
    });
    const wire = PublicErrorPayload.parse(thrown.payload);
    expect("detail" in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toMatch(/2000000123456789/);
  });

  test("a caller-supplied message and action override the defaults, and the code does not move", () => {
    const thrown = new PaymentsProductNotFoundError({ message: "Unknown pack.", action: "Pick another pack." });
    expect(thrown.payload.message).toBe("Unknown pack.");
    expect(thrown.payload.action).toBe("Pick another pack.");
    expect(thrown.payload.code).toBe("payments/product_not_found");
  });

  test("a cause is preserved, so a rail's own failure stays attached to the throw", () => {
    const cause = new Error("upstream 502");
    expect(new PaymentsProviderUnavailableError({}, { cause }).cause).toBe(cause);
  });
});
