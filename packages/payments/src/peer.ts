// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsPurchase } from "./data/purchase";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "./data/tables";
import { resolveEntitlements } from "./projection/resolve";

/**
 * **What a capability composed beside payments may read — handed to it, never imported by it** (#645).
 *
 * `@pithy-sh/payments` is an optional peer of `support`, which shows an operator what a sender bought and is
 * entitled to. It used to reach these modules by `import()` behind a `try`, and a literal specifier is one a
 * bundler resolves whether or not the branch holding it ever runs — so a project without payments could not
 * bundle support at all.
 *
 * So `payments()` carries this object as `paymentsPeer`, and a dependent finds it among the composed
 * capabilities in its `compose` hook. The dependent names this package only in a type, which a bundler never
 * sees. Reads only: the purchases table and the schema that decodes it, and the resolver every entitlement
 * gate in the kit already trusts.
 */
export const paymentsPeer = {
  PAYMENTS_PURCHASES_TABLE,
  paymentsDatabase,
  PaymentsPurchase,
  resolveEntitlements,
} as const;

/** Payments' peer surface, by type — what `paymentsPeer` holds. */
export type PaymentsPeer = typeof paymentsPeer;
