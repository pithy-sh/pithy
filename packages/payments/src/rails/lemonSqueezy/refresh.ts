// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import type { UnboundProviderEvent } from "../contract";
import type { LemonSqueezyHttpFetch } from "./api";
import { lemonSqueezyHttpFetch } from "./api";
import { orderEvent, subscriptionEvent } from "./objects";
import { readOrder, readSubscription } from "./read";

/**
 * Re-read a Lemon Squeezy purchase — the reconciliation path.
 *
 * Webhooks are dropped, endpoints are misconfigured, and a subscription can lapse with no notification
 * arriving at all. This is the question the reconciliation Workflow exists to ask, and this rail answers it
 * for real.
 *
 * ## Which rows it can answer for
 *
 * **State rows.** `providerTransactionId` is `subscription:<id>`, which is exactly the object Lemon Squeezy
 * can be asked about, and the answer is the subscription's standing now — the freshest fact anyone holds.
 *
 * **Order rows.** `order:<id>`, read back the same way.
 *
 * **Money rows are deliberately not refreshed.** A `subscription_invoice:` row records one closed billing
 * period, and it is born `expired` — which is in the Workflow's terminal set, so the pass never selects one.
 * Re-reading a closed invoice could only restate what it already says. Should one somehow reach here it
 * answers `undefined`, which the contract defines as "the store has nothing to say about this purchase" and
 * which leaves the row exactly as it stands.
 *
 * ## The clock is ours
 *
 * `providerEventAt` is `context.now`, not the object's `updated_at`, as the contract requires. A refresh is
 * a read of the state *now*, so it is the freshest fact there is — dating it earlier would let the monotonic
 * write rule discard the very repair this pass exists to make.
 */

/** What a refresh needs: the credentials, the clock, and the transport. */
export interface RefreshLemonSqueezyOptions {
  /** The rail's credentials. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** The clock. Stamped onto the returned event, per the contract. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: LemonSqueezyHttpFetch;
}

/** Split a namespaced id back into its type and its Lemon Squeezy id. */
function split(providerTransactionId: string): { type: string; id: string } | undefined {
  const at = providerTransactionId.indexOf(":");
  if (at <= 0) return undefined;
  return { type: providerTransactionId.slice(0, at), id: providerTransactionId.slice(at + 1) };
}

/** Re-read one purchase, or `undefined` when Lemon Squeezy has nothing to say about it. */
export async function refreshLemonSqueezyPurchase(
  purchase: PaymentsPurchase,
  options: RefreshLemonSqueezyOptions,
): Promise<UnboundProviderEvent | undefined> {
  // **The row's own key, never the family's.** Other rails fall back to `originalTransactionId` because
  // their store can only be asked about the family — Apple's `originalTransactionId`, Play's purchase token.
  // Here the row's own key already names an addressable object, and falling back would be actively wrong: a
  // money row's family key is `subscription:<id>`, so it would re-read the *subscription* and answer with a
  // state event keyed to a different row. Reconciliation would then read that as the row having been
  // superseded, mark the invoice expired, and project nothing in its place.
  const key = split(purchase.providerTransactionId);
  if (key === undefined) return undefined;

  const read = { credentials: options.credentials, transport: options.transport ?? lemonSqueezyHttpFetch };

  if (key.type === "subscription") {
    const subscription = await readSubscription(key.id, read);
    if (subscription === undefined) return undefined;
    return { ...subscriptionEvent(key.id, subscription), providerEventAt: options.now };
  }

  if (key.type === "order") {
    const order = await readOrder(key.id, read);
    if (order === undefined) return undefined;
    return { ...orderEvent(key.id, order), providerEventAt: options.now };
  }

  // A `subscription_invoice:` row, or a prefix a later build wrote. Nothing to re-read — see the module doc.
  return undefined;
}
