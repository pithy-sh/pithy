// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurchaseEnvironment } from "../../data/purchase";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { VerifiedPurchase } from "../contract";
import type { PaddleEnvironment, PaddleHttpFetch } from "./api";
import { accountReferenceOf, PADDLE_CUSTOM_ACCOUNT, transactionEvent } from "./objects";
import { readTransaction } from "./read";

/**
 * Verifying a transaction id a returning buyer handed back — and why this rail has one where Lemon
 * Squeezy does not.
 *
 * ## What makes a submitted `txn_…` trustworthy here
 *
 * Not that it is unguessable. Lemon Squeezy's order UUID is unguessable too, and `verify.ts` there
 * refuses it at length: an unguessable-but-unauthenticated identifier lets a client's choice of value
 * decide who a purchase belongs to.
 *
 * What makes this one safe is the **check against the caller**, not the id. The transaction is read from
 * Paddle, and its `custom_data.pithy_user` — a value this deployment's own server wrote, with a MAC only
 * this deployment could produce — has to name the authenticated caller. A submitted id that names somebody
 * else is refused, and one carrying no proven reference is refused too. So the id is a *pointer*; the
 * authorization is the stamp.
 *
 * ## Why the rail needs it at all
 *
 * `dev` is not publicly routable, so a dev checkout's webhooks land at `staging` and the dev deployment
 * never hears about its own purchase. The overlay's `checkout.completed` callback hands the browser a
 * `txn_…`; the screen posts it here; this binds it. That is what makes local development work, and it is
 * why `verify` is not optional on this rail the way it is on Lemon Squeezy.
 *
 * It is also the ordinary web nicety: a buyer sees their entitlement the moment the overlay closes rather
 * than when the webhook lands. The webhook stays authoritative, produces the identical row, and the write
 * is idempotent on `(rail, providerTransactionId)`.
 */

/** What verifying a submitted transaction needs. */
export interface VerifyPaddleTransactionOptions {
  /** The rail's credentials. `webhookSecret` keys the ownership proof; `apiKey` reads the transaction. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to read from. */
  environment: PaddleEnvironment;
  /** This deployment's `ENVIRONMENT`. Without it no reference is trusted, so no submission is accepted. */
  deployment?: string;
  /** The clock — the returned event's `providerEventAt`, because a read is a fact about now. */
  now: Date;
  /** The HTTP seam. */
  transport: PaddleHttpFetch;
}

/** Paddle's transaction ids. Checked before a round trip, so a malformed one costs nothing. */
const TRANSACTION_ID = /^txn_[a-z0-9]+$/;

/** Verify one submitted Paddle transaction id, and report who it says it belongs to. */
export async function verifyPaddleTransaction(
  receipt: string,
  options: VerifyPaddleTransactionOptions,
): Promise<VerifiedPurchase> {
  const id = receipt.trim();
  if (!TRANSACTION_ID.test(id)) {
    throw new PaymentsInvalidReceiptError({
      message: "That isn't a Paddle transaction.",
      action: "Submit the `txn_…` the checkout's completion callback handed back.",
      detail: `A Paddle receipt is a transaction id of the form txn_…; this one is ${id.length} characters and does not match.`,
    });
  }

  const transaction = await readTransaction(id, {
    credentials: options.credentials,
    environment: options.environment,
    transport: options.transport,
  });
  if (transaction === undefined) {
    throw new PaymentsVerificationFailedError({
      message: "We couldn't confirm that purchase.",
      detail: `Paddle does not know transaction ${id} on this account.`,
    });
  }

  // **The reference, proven.** `accountReferenceOf` returns null unless the stamp carries a MAC this
  // deployment's secret produces over (environment, user). A transaction created through
  // `Paddle.Checkout.open` by a stranger can carry any `pithy_user` it likes and cannot carry this.
  const reference = await accountReferenceOf(
    transaction.custom_data,
    options.deployment,
    options.credentials.webhookSecret,
  );

  if (reference === null) {
    // Either nothing this server wrote, or a stamp whose proof does not verify, or a deployment that does
    // not know its own environment. All three mean the same thing: this submission carries no evidence of
    // ownership, and the route has nothing to check the caller against.
    //
    // The refusal deliberately does not distinguish them, and does not echo whatever `pithy_user` the
    // payload claimed. A caller learning "the transaction says it belongs to somebody else" learns that a
    // transaction id exists and is owned; `detail` carries the distinction for the operator.
    const claimed = transaction.custom_data?.[PADDLE_CUSTOM_ACCOUNT];
    throw new PaymentsVerificationFailedError({
      message: "We couldn't confirm that purchase.",
      detail: `Paddle transaction ${id} carries no account reference this deployment can prove it wrote${
        typeof claimed === "string" ? " (a claimed reference was present but unproven)" : ""
      }.`,
    });
  }

  const environment: PurchaseEnvironment = options.environment === "production" ? "production" : "sandbox";

  return {
    // The clock, not the transaction's own timestamp: a verify is a read of the state now, and dating it
    // earlier would let the monotonic write rule discard it behind a webhook that arrived first.
    event: { ...transactionEvent(transaction, options.now, environment), providerEventAt: options.now },
    providerAccountId: transaction.customer_id ?? null,
    // The route refuses a submission whose reference names somebody other than the caller. That check
    // lives there because the route is the only place that knows who is authenticated.
    accountReference: reference,
  };
}
