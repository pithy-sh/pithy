import type { PaymentsPurchase } from "../../data/purchase";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { UnboundProviderEvent } from "../contract";
import { type StripeHttpFetch, stripeHttpFetch, stripeJson } from "./api";
import { mapStripeSubscription, StripeSubscription } from "./objects";

/**
 * Re-read one stored subscription at Stripe, normalized — the reconciliation path for this rail.
 *
 * **A subscription retrieve, not an invoice one, and that is the whole design.** A row is keyed on the invoice
 * because each billing period is its own purchase; the *subscription* is what has a current state, and it is
 * what `originalTransactionId` holds. So the retrieve is by `sub_…` and the mapping is the identical one the
 * webhook path uses — `mapStripeSubscription`, not a second reading of Stripe's vocabulary that could drift
 * from it. The invoice the answer names becomes the row's key, which means a period this deployment never
 * heard a webhook for projects as its own new row rather than overwriting the last one it did hear about.
 *
 * **Subscriptions only.** A one-time Stripe purchase is a payment intent, and a payment intent does not change
 * after it succeeds — the one thing that changes it is a refund, which arrives as `charge.refunded`. There is
 * nothing for a periodic re-read to discover, so there is no call here to make.
 *
 * **Unlike Google there is nothing to batch.** Stripe authenticates every request with the secret key
 * directly, so a hundred refreshes are a hundred round-trips and no token minting at all.
 */

/** What a Stripe refresh needs: the API key, the clock, and the transport. */
export interface StripeRefreshOptions {
  /** Stripe's credential block. Only `secretKey` is used here. */
  credentials: PaymentsStripeCredentials;
  /** The clock. A retrieve is a read of the state now, so this is the honest provider event time. */
  now: Date;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: StripeHttpFetch;
}

/** Re-read a stored Stripe subscription, or `undefined` when there is nothing addressable to read. */
export async function refreshStripeSubscription(
  purchase: PaymentsPurchase,
  options: StripeRefreshOptions,
): Promise<UnboundProviderEvent | undefined> {
  if (purchase.type !== "subscription") return undefined;

  // The subscription id, which every invoice row of the family carries. A row written from a Checkout Session
  // whose subscription was never expanded has none, and there is nothing to retrieve.
  const subscriptionId = purchase.originalTransactionId;
  if (subscriptionId === null) return undefined;

  const retrieved = await stripeJson(
    options.transport ?? stripeHttpFetch,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      what: "the subscription",
      secretKey: options.credentials.secretKey,
      absentOn404: true,
    },
  );
  // Deleted at Stripe, or belonging to the other mode's account. Either way the row stays exactly as it stood:
  // a subscription we cannot read is not evidence that anybody's access ended.
  if (retrieved === undefined) return undefined;

  const parsed = StripeSubscription.safeParse(retrieved);
  if (!parsed.success) {
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: the answer is not a Subscription — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }

  // The clock as the provider event time. A retrieve has none of its own, and dating it by the subscription's
  // `created` would put every repair behind every notification it is meant to correct.
  //
  // `?? undefined` rather than passing the null through: the mapper's `null` means "this object described no
  // transaction", which is the same statement as "nothing to refresh" and must not read as a distinct outcome.
  return mapStripeSubscription(parsed.data, options.now).event ?? undefined;
}
