// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProductType } from "../config/config";
import { PurchaseEnvironment } from "../data/purchase";
import { PaymentsRail } from "../data/rail";
import { PurchaseStatus } from "../data/status";

/**
 * What the payments routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help — so every client that had only an interface hand-wrote a mirror, and the mirror drifted
 * the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 *
 * **Nothing here is a receipt.** `PaymentsPurchase.payload` is the whole verified provider response,
 * and a bearer artifact; the purchase view is the normalized projection of it, and there is no field
 * that carries the original. The webhook responses are deliberately absent from this file too — they
 * are acknowledgements addressed to Apple, Google and Stripe, not a contract offered to any client.
 */

/** One entitlement as a client reads it. */
export const PaymentsEntitlementView = z
  .object({
    key: z.string().describe("The entitlement key, as the catalog spells it."),
    granted: z.boolean().describe("Whether it grants right now. Re-checked against `expiresAt` on every read."),
    expiresAt: z.iso.datetime().nullable().describe("When it lapses, ISO-8601; null when it does not."),
  })
  .describe("One entitlement: the key, whether it grants right now, and when it lapses.");
export type PaymentsEntitlementView = z.output<typeof PaymentsEntitlementView>;

/** One purchase as a client may see it — the normalized projection, never the stored provider payload. */
export const PaymentsPurchaseView = z
  .object({
    id: z.string().describe("The purchase's UUID."),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    productId: z.string().describe("The catalog product the verified SKU resolved to."),
    type: PaymentsProductType.describe("What kind of product it is."),
    status: PurchaseStatus.describe("The normalized status. Nothing here is ever a rail-specific state."),
    environment: PurchaseEnvironment.describe(
      "The store environment it happened in. A sandbox purchase never grants in production.",
    ),
    purchasedAt: z.iso.datetime().describe("When the store recorded the purchase, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When the entitlement it bought lapses, ISO-8601; null when none."),
    outcome: z
      .enum(["created", "updated", "ignored"])
      .describe(
        "What the write actually did. `ignored` is a success — a replay of a receipt already projected, or an event staler than the row it would have overwritten.",
      ),
  })
  .describe("One purchase as the projection left it. Never the receipt, which is a bearer artifact.");
export type PaymentsPurchaseView = z.output<typeof PaymentsPurchaseView>;

/** `POST {base}/purchases`. */
export const PaymentsPurchaseResponse = z
  .object({
    purchase: PaymentsPurchaseView.describe("The purchase as this submission left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("What that purchase grants, resolved now."),
  })
  .describe("A verified purchase and the entitlements it produced.");
export type PaymentsPurchaseResponse = z.output<typeof PaymentsPurchaseResponse>;

/** `GET {base}/entitlements` — always the caller's own. */
export const PaymentsEntitlementsResponse = z
  .object({ entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements, resolved now.") })
  .describe("Every entitlement the caller holds.");
export type PaymentsEntitlementsResponse = z.output<typeof PaymentsEntitlementsResponse>;

/** `POST {base}/restore`. */
export const PaymentsRestoreResponse = z
  .object({
    purchases: z.array(PaymentsPurchaseView).describe("Every receipt in the batch, as the projection left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements after the restore."),
  })
  .describe("What a Restore Purchases run projected, and what the caller now holds.");
export type PaymentsRestoreResponse = z.output<typeof PaymentsRestoreResponse>;

/** `POST {base}/checkout` and `POST {base}/portal` — the hosted Stripe flows. */
export const PaymentsHostedSessionResponse = z
  .object({
    url: z.string().describe("Where to send the browser. Stripe's own hosted page; it expires on Stripe's schedule."),
  })
  .describe("Where to send the buyer for a hosted Stripe flow.");
export type PaymentsHostedSessionResponse = z.output<typeof PaymentsHostedSessionResponse>;

/**
 * `POST {base}/entitlements/grant` and `POST {base}/entitlements/revoke` — the two control-plane routes.
 *
 * One shape for both, because both are the same act read two ways: the entitlement as it now stands.
 * A revoke returns `granted: false` rather than nothing, so a management client renders the state it
 * produced instead of assuming it.
 */
export const PaymentsEntitlementResponse = z
  .object({ entitlement: PaymentsEntitlementView.describe("The entitlement as the write left it.") })
  .describe("The single entitlement a management client granted or revoked, as it now stands.");
export type PaymentsEntitlementResponse = z.output<typeof PaymentsEntitlementResponse>;
