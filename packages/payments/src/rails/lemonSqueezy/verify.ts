// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsInvalidReceiptError } from "../../error/errors";
import type { VerifiedPurchase } from "../contract";

/**
 * This rail has no client-submittable receipt, and says so.
 *
 * ## Why refusing is the secure answer
 *
 * `verify` exists so a buyer sees their entitlement without waiting for the webhook. Stripe can do that
 * because a returning buyer carries a Checkout Session id that Stripe substituted into the success URL: an
 * unguessable token this deployment's own server can trade for a session carrying `client_reference_id`.
 *
 * Lemon Squeezy has no equivalent. Its order ids are **sequential integers**, so a `verify` that trusted a
 * submitted order id would let any authenticated caller claim any order in the store by counting — including
 * one belonging to somebody who has not signed in yet, whose purchase would then be bound to the attacker
 * forever, because `linkProviderAccount` never rebinds and the first pairing wins.
 *
 * The order's UUID `identifier` was the obvious repair and is not one. It is unguessable, but it is not a
 * *credential*: it appears in the buyer's own receipt email and in the storefront's return URL, so it proves
 * possession of a value that was never secret, and Lemon Squeezy does not return `custom_data` on the order
 * object in a form this server could check against the caller. Binding on an unguessable-but-unauthenticated
 * identifier is exactly the class of mistake the {@link VerifiedPurchase.accountReference} doc warns about:
 * it lets a client's choice of value decide who a purchase belongs to.
 *
 * ## What it costs, stated plainly
 *
 * A Lemon Squeezy buyer's entitlement appears when the webhook lands rather than the moment they return —
 * seconds, usually. The `successUrl` this rail's config asks for should therefore show a pending state and
 * poll, not post a receipt. `docs/lemon-squeezy.md` says so, and the scaffolded return page does it.
 *
 * The webhook is authoritative on every rail anyway. Here it is simply the only path.
 */

/** Refuse a submitted Lemon Squeezy receipt. There is no shape of one that could be trusted. */
export async function verifyLemonSqueezyOrder(_receipt: string): Promise<VerifiedPurchase> {
  throw new PaymentsInvalidReceiptError({
    message: "Lemon Squeezy purchases confirm themselves.",
    action: "Nothing to submit. Your purchase appears as soon as Lemon Squeezy tells the server about it.",
    detail:
      "Lemon Squeezy has no client-submittable receipt: an order id is a sequential integer, and the order object carries no reference this server set, so accepting one would let any authenticated caller claim an unprojected order by counting. Purchases on this rail land through the webhook alone.",
  });
}
