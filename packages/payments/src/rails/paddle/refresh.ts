// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SubscriptionPricing } from "../../data/discount";
import type { PaymentsPurchase } from "../../data/purchase";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { UnboundProviderEvent } from "../contract";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson } from "./api";
import { currencyOf, minorAmount, subscriptionEvent, transactionEvent } from "./objects";
import { readSubscription, readTransaction } from "./read";

/**
 * Re-read a Paddle purchase — the reconciliation path — and read what it pays.
 *
 * Webhooks are dropped, destinations are misconfigured, and a subscription can lapse with no notification
 * arriving at all. This is the question the reconciliation Workflow exists to ask, and this rail answers
 * it for real.
 *
 * ## Which rows it can answer for
 *
 * Paddle's ids are globally prefixed, so the row's own key says what to ask: `sub_…` is a subscription,
 * `txn_…` is a transaction. Both are addressable, so both are re-read — unlike Lemon Squeezy, where a
 * money row records a closed period and has nothing to re-read.
 *
 * A **subscription** transaction's money row is born `expired`, which is in the Workflow's terminal set,
 * so the pass never selects one. Should one reach here it is answered honestly rather than skipped: a
 * refunded transaction is exactly the thing worth re-reading.
 *
 * ## The clock is ours
 *
 * `providerEventAt` is `context.now`, not the object's `updated_at`, as the contract requires. A refresh
 * is a read of the state *now*, so it is the freshest fact there is — dating it earlier would let the
 * monotonic write rule discard the very repair this pass exists to make.
 */

/** What a refresh needs: the credentials, the account, the clock, and the transport. */
export interface RefreshPaddleOptions {
  /** The rail's credentials. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to read from. */
  environment: PaddleEnvironment;
  /** The clock. Stamped onto the returned event, per the contract. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/** Re-read one purchase, or `undefined` when Paddle has nothing to say about it. */
export async function refreshPaddlePurchase(
  purchase: PaymentsPurchase,
  options: RefreshPaddleOptions,
): Promise<UnboundProviderEvent | undefined> {
  const read = {
    credentials: options.credentials,
    environment: options.environment,
    transport: options.transport ?? paddleHttpFetch,
  };
  // **The row's own key, never the family's.** A money row's family key is `sub_…`, so falling back would
  // re-read the subscription and answer with a state event keyed to a different row — which reconciliation
  // would read as the row having been superseded.
  const id = purchase.providerTransactionId;
  const environment = options.environment === "production" ? "production" : "sandbox";

  if (id.startsWith("sub_")) {
    const subscription = await readSubscription(id, read);
    if (subscription === undefined) return undefined;
    return { ...subscriptionEvent(subscription, options.now, environment), providerEventAt: options.now };
  }

  if (id.startsWith("txn_")) {
    const transaction = await readTransaction(id, read);
    if (transaction === undefined) return undefined;
    return { ...transactionEvent(transaction, options.now, environment), providerEventAt: options.now };
  }

  // A prefix a later build wrote. Nothing to re-read, which the contract defines as "the store has
  // nothing to say about this purchase" and which leaves the row exactly as it stands.
  return undefined;
}

/**
 * What a Paddle subscription pays now, what it becomes, and when.
 *
 * Read from Paddle rather than computed. `include=next_transaction` carries what the next invoice comes
 * to under any discount in force; `include=recurring_transaction_details` carries what it comes to at
 * list price. Nothing here multiplies a price by a percentage — a second calculation would be a second
 * answer to the one question a customer checks against their statement.
 *
 * Only a `sub_…` row can be asked. A transaction records one closed period and has no "next", so it
 * answers `undefined` — the same "nothing to say about this purchase" the refresh path uses.
 */
export async function readPaddlePricing(
  purchase: PaymentsPurchase,
  options: RefreshPaddleOptions,
): Promise<SubscriptionPricing | undefined> {
  const id = purchase.providerTransactionId;
  if (!id.startsWith("sub_")) return undefined;

  const answer = await paddleJson(options.transport ?? paddleHttpFetch, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `subscription ${id}'s pricing`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    query: [["include", "next_transaction,recurring_transaction_details"]],
    absentOn404: true,
  });
  if (answer === undefined) return undefined;

  const data = answer.data as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") return undefined;

  const next = totalsOf(data.next_transaction);
  const recurring = totalsOf(data.recurring_transaction_details);
  const discount = data.discount as Record<string, unknown> | null | undefined;
  const endsAt = typeof discount?.ends_at === "string" ? new Date(discount.ends_at) : null;

  return {
    currency: next.currency ?? recurring.currency,
    // What the next invoice actually comes to, under whatever is in force.
    currentAmountMinor: next.total ?? recurring.total,
    // What it comes to at list price. Equal to the current amount when no discount is in force, which is
    // how a screen tells "this is your rate" from "this is your rate until March".
    listAmountMinor: recurring.total ?? next.total,
    // **Always null, and that is a stated limitation rather than a gap.** Paddle's subscription object
    // carries `discount.id` and no code, so naming the code would mean a second round trip on every
    // read of a screen a customer refreshes. `discountEndsAt` is the field that stops a bill changing
    // unannounced, and it is here: a screen says "your rate changes on the 3rd" without naming the code
    // that set it.
    discountCode: null,
    discountEndsAt: endsAt !== null && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
  };
}

/**
 * Pull the total and its currency out of whichever include shape carried it.
 *
 * **The two includes are not the same shape**, and a reader that knew only one would silently answer null
 * for the other — leaving a screen reporting no list price and a customer told nothing about the date
 * their rate changes. `next_transaction` nests its figures under `details.totals`; `recurring_transaction
 * _details` carries `totals` at the top. Both are checked, in that order.
 */
function totalsOf(value: unknown): { total: number | null; currency: string | null } {
  if (value === null || typeof value !== "object") return { total: null, currency: null };
  const bagged = value as Record<string, unknown>;
  const details = bagged.details;
  const nested = details !== null && typeof details === "object" ? (details as Record<string, unknown>).totals : null;
  const totals = nested ?? bagged.totals ?? null;
  if (totals === null || typeof totals !== "object") return { total: null, currency: null };
  const bag = totals as Record<string, unknown>;
  return {
    total: minorAmount(typeof bag.total === "string" ? bag.total : (bag.grand_total as string | undefined)),
    currency: currencyOf(typeof bag.currency_code === "string" ? bag.currency_code : null),
  };
}
