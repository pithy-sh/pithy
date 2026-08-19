// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { clientError } from "@pithy-sh/core/src/error/client";
import { KitErrorPayload, PublicErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import {
  PaymentsEntitlementNotInCatalogError,
  PaymentsEntitlementRequiredError,
  PaymentsEnvironmentMismatchError,
  PaymentsInvalidReceiptError,
  PaymentsProductNotFoundError,
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
  PaymentsSubjectUnresolvedError,
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
  {
    error: () => new PaymentsEntitlementNotInCatalogError(),
    code: "payments/entitlement_not_in_catalog",
    status: 400,
  },
  { error: () => new PaymentsSubjectUnresolvedError(), code: "payments/subject_unresolved", status: 403 },
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

  test("the catalog refusal names the key in the message and the defined set only in detail", () => {
    // The client-safe half echoes what the caller sent; the set it got wrong is throw-site context, and
    // the codec strips it. What this project sells is a separate disclosure behind `payments:catalog:read`,
    // and a refusal that listed it would be that read with no gate on it.
    const thrown = new PaymentsEntitlementNotInCatalogError({
      message: 'No entitlement "pr" is defined here.',
      detail: 'No product grants "pr". Defined: coins, pro.',
    });
    expect(thrown.payload.message).toContain("pr");
    const wire = PublicErrorPayload.parse(thrown.payload);
    expect(JSON.stringify(wire)).not.toContain("coins");
    expect("detail" in wire).toBe(false);
  });

  test("the unresolved-subject refusal keeps the operator's words off the wire", () => {
    // Three fields, three audiences, and this code is the one where they diverge most. The caller is
    // told to pick an account, which is something they can do. That the project bills organizations,
    // that a resolver in pithy.config.ts returned nothing — those are the operator's sentences, and
    // naming a config key to a stranger is a map of the deployment they did not need.
    const thrown = new PaymentsSubjectUnresolvedError({
      detail: "billingSubject=organization; resolver returned undefined",
    });
    expect(thrown.payload.status).toBe(403);
    expect(thrown.payload.message).not.toMatch(/billingSubject|pithy\.config|resolver|seam/i);
    expect(thrown.payload.action).toMatch(/billingSubject/);

    const wire = clientError(thrown.payload);
    expect("action" in wire).toBe(false);
    expect("detail" in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toMatch(/billingSubject|resolver/);
  });

  test("a cause is preserved, so a rail's own failure stays attached to the throw", () => {
    const cause = new Error("upstream 502");
    expect(new PaymentsProviderUnavailableError({}, { cause }).cause).toBe(cause);
  });
});
