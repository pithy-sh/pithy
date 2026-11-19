// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { adminRouteTable, type DeclaredRoute, declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";
import { paymentsAdminRoutes } from "./scopes";

/**
 * Every route `registerPaymentsRoutes` mounts under `base`: the management surface, purchases and entitlements,
 * every rail's webhook, checkout and the portal, pricing, the subscription, and the adopter's entitlement writes.
 */
export function paymentsRouteTable(base: string): DeclaredRoute[] {
  return [
    ...adminRouteTable(paymentsAdminRoutes(base)),
    ...declareRoutes(base, [
      ["POST", "/purchases"],
      ["GET", "/entitlements"],
      ["POST", "/restore"],
      ["POST", "/webhooks/apple"],
      ["POST", "/webhooks/google"],
      ["POST", "/webhooks/stripe"],
      ["POST", "/webhooks/lemon-squeezy"],
      ["POST", "/webhooks/paddle"],
      ["POST", "/checkout"],
      ["GET", "/checkout/resume"],
      ["POST", "/portal"],
      ["GET", "/pricing"],
      ["GET", "/subscription"],
      ["POST", "/subscription/preview"],
      ["POST", "/subscription/change"],
      ["POST", "/subscription/cancel"],
      ["POST", "/subscription/keep"],
      ["POST", "/subscription/refund"],
    ]),
  ];
}
