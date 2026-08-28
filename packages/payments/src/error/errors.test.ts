// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { clientError } from "@pithy-sh/core/src/error/client";
import { KitErrorPayload, PublicErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import * as vehicles from "./errors";
import {
  PaymentsClawbackFailedError,
  PaymentsDiscountInvalidError,
  PaymentsEntitlementNotInCatalogError,
  PaymentsEntitlementRequiredError,
  PaymentsEnvironmentMismatchError,
  PaymentsInvalidReceiptError,
  PaymentsProductNotFoundError,
  PaymentsProviderUnavailableError,
  PaymentsRailNotConfiguredError,
  PaymentsReceiptAlreadyOwnedError,
  PaymentsSubjectUnresolvedError,
  PaymentsSubscriptionChangeRefusedError,
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
  { error: () => new PaymentsClawbackFailedError(), code: "payments/clawback_failed", status: 409 },
  { error: () => new PaymentsDiscountInvalidError(), code: "payments/discount_invalid", status: 400 },
  {
    error: () => new PaymentsSubscriptionChangeRefusedError(),
    code: "payments/subscription_change_refused",
    status: 409,
  },
] as const;

describe("payments error family", () => {
  test("every vehicle this module exports is in FAMILY, so the checks below cover the domain", () => {
    // The list above calls itself "every vehicle in the domain" and, until this gate, was not. Two
    // classes — `clawback_failed` and `discount_invalid` — had been added to `errors.ts` and never to
    // FAMILY, so the status each carries was never once compared against the one core's union pins
    // for it, and the file that reads like a check was a claim over a subset. Enumerating the module
    // is what makes the claim maintain itself: a class added with no entry here fails, rather than
    // quietly widening the gap.
    const exported = Object.entries(vehicles)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    const covered = FAMILY.map(({ error }) => error().constructor.name).sort();
    expect(covered).toEqual(exported);
  });

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

  test("the subscription refusal splits its three fields three ways", () => {
    // The sibling describe below argues the code and proves `detail` never lands on the wire. What is
    // left to pin is `action`, which is the field neither of the other two can stand in for: a caller
    // reads `message` and can only re-read their subscription, where an operator needs to be told which
    // of the subscription's facts to go and look at. Naming them in `message` would hand a stranger the
    // shape of somebody's billing; leaving them out of `action` entirely would make the refusal
    // unactionable by the one person who can act on it.
    const thrown = new PaymentsSubscriptionChangeRefusedError();
    expect(thrown.payload.message).not.toMatch(/item|quantity|proration|paddle|rail/i);
    expect(thrown.payload.action).toMatch(/scheduled change/i);
    expect("action" in clientError(thrown.payload)).toBe(false);
  });

  test("a cause is preserved, so a rail's own failure stays attached to the throw", () => {
    const cause = new Error("upstream 502");
    expect(new PaymentsProviderUnavailableError({}, { cause }).cause).toBe(cause);
  });
});

describe("the subscription-change refusal (#465)", () => {
  test("409, because the request is well-formed and it is the subscription that forbids it", () => {
    // Not 400: the caller named a price this project sells and a subscription they hold. Not 500:
    // nothing is broken. The refusal is about the state of the resource, which is what 409 means and
    // what tells a client to re-read the subscription rather than re-word the request.
    expect(new PaymentsSubscriptionChangeRefusedError().payload.status).toBe(409);
  });

  test("one code carries all three refusals, and which one it was stays in detail", () => {
    // The three cases differ only in throw-site context, and the codec strips throw-site context. A
    // subscription's item count and the price ids on it are the shape of somebody's billing; a stranger
    // who can provoke the refusal must not be able to read it back out of the response.
    const shape = new PaymentsSubscriptionChangeRefusedError({
      detail: "sub_01kzvyz9 carries 2 items (pri_solo x1, pri_addon x3); this rail replaces the whole array",
    });
    const canceled = new PaymentsSubscriptionChangeRefusedError({
      detail: "sub_01kzvyz9 status=canceled; nothing to change",
    });
    const contradiction = new PaymentsSubscriptionChangeRefusedError({
      detail: "withdrawal asked of sub_01kzvyz9, which holds scheduled_change=null",
    });
    for (const thrown of [shape, canceled, contradiction]) {
      expect(thrown.payload.code).toBe("payments/subscription_change_refused");
      const wire = clientError(thrown.payload);
      expect("detail" in wire).toBe(false);
      expect("action" in wire).toBe(false);
      expect(JSON.stringify(wire)).not.toMatch(/sub_01kzvyz9|pri_solo|pri_addon|scheduled_change/);
    }
  });

  test("the default message names no price, no item count and no subscription id", () => {
    // The default is what a throw site that supplies nothing hands a stranger, so it has to be safe on
    // its own. Anything specific is the caller's to be told through `params`, deliberately.
    const wire = clientError(new PaymentsSubscriptionChangeRefusedError().payload);
    expect(JSON.stringify(wire)).not.toMatch(/sub_|pri_|item|quantit/i);
  });

  test("params cross the boundary with the message, where `action` and `detail` do not", () => {
    // The one client-facing field that is also specific, and the pairing is the point: a pane rendering
    // "ends on 15 September" in the reader's own language needs the date, and the date is not a secret —
    // where the subscription id sitting beside it in `detail` is. Asserted on the wire projection,
    // because a field that survives the codec is the only kind a translating client can read.
    const thrown = new PaymentsSubscriptionChangeRefusedError({
      params: { endsAt: "2026-09-15" },
      detail: "sub_01kzvyz9 has a cancel scheduled for 2026-09-15T11:42:21.789Z",
    });
    const wire = clientError(thrown.payload);
    expect(wire.params).toEqual({ endsAt: "2026-09-15" });
    expect(JSON.stringify(wire)).not.toMatch(/sub_01kzvyz9|11:42:21/);
  });
});
