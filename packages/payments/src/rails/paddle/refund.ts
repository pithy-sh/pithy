// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsPurchase } from "../../data/purchase";
import { RefundRequest, type RefundRequestOutcome, type RefundRequestStatus } from "../../data/subscription";
import { PaymentsProviderUnavailableError, PaymentsSubscriptionChangeRefusedError } from "../../error/errors";
import type { PaymentsPaddleCredentials } from "../../secret/registry";
import type { RefundRequestInput } from "../contract";
import { REVOKING_ACTIONS } from "./adjustments";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleHttpFetch, paddleJson, redactPaddleSecrets } from "./api";
import { PaddleAdjustment, type PaddleTransaction } from "./objects";
import { PADDLE_ADJUSTMENTS_INCLUDE, readTransaction } from "./read";

/**
 * Asking Paddle to give a subscriber's payments back — the fourth verb of #465.
 *
 * ## Three facts about Paddle shaped every line of this
 *
 * **1. It is a request, not a completion.** `POST /adjustments` creates an adjustment, and on a live
 * account Paddle holds most refunds at `pending_approval` until a person there reviews them; the sandbox
 * approves on its own, roughly ten minutes later. So nothing here says the money moved, nothing revokes an
 * entitlement, and nothing writes a purchase row. An approved refund arrives as a webhook, and
 * `adjustments.ts` and the projection writer already act on it — they are the only things that do.
 * Revoking on the *request* would take access from a customer whose refund Paddle then rejects, leaving
 * them with neither the money nor the product.
 *
 * **2. Refunds attach to a transaction, not to a subscription.** There is no endpoint that refunds a
 * subscription, so this raises one adjustment per transaction and reports one outcome per transaction.
 * The case is ordinary: a customer who joined on Solo at 6.00, upgraded to Team on day 10 for a 65.82
 * proration and cancels on day 13 has paid twice, and a refund policy owes them both.
 *
 * **3. They do not stack.** Paddle: *"You can't create an adjustment for a transaction that has a refund
 * that's pending approval."* Learning that from Paddle, mid-set, after other adjustments have already been
 * raised, is the worst possible place to learn it — so it is decided here, from the transaction's own
 * `include=adjustments`, before anything is sent.
 *
 * ## The guarantee, and the line it is split at
 *
 * All-or-nothing across the whole set **cannot be built**: Paddle offers no batch adjustment and no delete,
 * so once the first one is at `pending_approval` nothing un-raises it. The guarantee is therefore split at
 * the only line that is real — whether this call has written anything yet:
 *
 * - **Before the first write**, every transaction is read and checked, and anything that makes one
 *   unrefundable refuses the *whole request* with `payments/subscription_change_refused` having sent
 *   nothing. {@link MAX_PADDLE_REFUND_TRANSACTIONS} is enforced first, for the same reason.
 * - **After the first write**, nothing throws. Every remaining failure becomes a `failed` outcome, because
 *   an error raised over a state where money is already moving is precisely the silent partial this module
 *   is designed against.
 *
 * A refund that is already standing is neither: it is reported as `already_requested` and no call is made.
 * That is the per-payment form of the no-op rule the other four verbs follow — a retried write must not
 * become a second refund, and a 409 for the state the caller asked for is simply wrong.
 *
 * ## The window is not here
 *
 * How long a customer has to ask for their money back is the **adopter's** policy, with a company's
 * commercial decisions behind it. This module refunds what it is handed and hard-codes no window; the
 * adopter's screen decides which button exists.
 */

/** What every call here needs: the credentials, which Paddle account, and the transport. */
export interface PaddleRefundOptions {
  /** The rail's credentials. The API key is read at the point of need and never cached. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to reach. */
  environment: PaddleEnvironment;
  /** The HTTP seam. Defaults to the runtime's `fetch`. */
  transport?: PaddleHttpFetch;
}

/**
 * The most transactions one request will refund.
 *
 * **A bound on subrequests, not a policy.** Each transaction costs two calls — a read and a create — and a
 * Worker's subrequest budget is finite. A call that runs out of it half way through is a partial by
 * another name, and the one thing this module will not produce. So the size is checked before anything is
 * read, and a set that is too large is refused whole.
 *
 * Twelve, and the two ends of the range are what pick it. Any refund window an adopter would set holds one
 * or two transactions on a monthly plan — the recorded upgrade case is two — so nothing legitimate comes
 * near it. And twenty-four calls sits well inside the budget with room for everything else a request does.
 * An adopter reversing a whole subscription history is doing something else, and the Paddle dashboard is
 * the tool for it.
 */
export const MAX_PADDLE_REFUND_TRANSACTIONS = 12;

/** What Paddle sends and what this module states. Anything else is `unknown` — see the enum's own doc. */
const REFUND_STATUS: Readonly<Record<string, RefundRequestStatus>> = {
  pending_approval: "awaiting_review",
  approved: "approved",
  rejected: "rejected",
  reversed: "reversed",
};

/** The request cannot be honored, and nothing has been sent. 409, with the reason in `detail`. */
function refuse(detail: string): never {
  throw new PaymentsSubscriptionChangeRefusedError({
    message: "That refund cannot be requested.",
    action: "Re-read the subscription and the payments on it, then ask for a refund the present state allows.",
    detail,
  });
}

/** The transaction this purchase row names, or null when it names none. */
function transactionIdOf(purchase: PaymentsPurchase): string | null {
  const id = purchase.providerTransactionId;
  return id.startsWith("txn_") ? id : null;
}

/**
 * The adjustment already standing against this transaction, or undefined.
 *
 * **Two cases block, and one deliberately does not.** A `refund` awaiting review blocks because Paddle
 * refuses a second one outright. An *approved* revoking adjustment — {@link REVOKING_ACTIONS}, so a
 * chargeback counts — blocks because the money is already back and a second refund would send it twice.
 *
 * A **rejected** refund does not block. A reviewer at Paddle turning one down is not a permanent bar, and
 * treating it as one would make somebody else's decision final over money the adopter has chosen to give
 * back. Neither does a `credit` against a balance, which is not a revocation — the same line
 * `adjustments.ts` draws, read from its set rather than restated here.
 */
function standingRefund(transaction: PaddleTransaction): PaddleAdjustment | undefined {
  return (transaction.adjustments ?? []).find((one) => {
    if (one.status === "pending_approval") return one.action === "refund";
    return one.status === "approved" && REVOKING_ACTIONS.has(one.action);
  });
}

/** One payment, checked at the store and ready to be acted on. */
interface Checked {
  /** The row the outcome is reported against. */
  purchase: PaymentsPurchase;
  /** The Paddle transaction to refund. */
  transactionId: string;
  /** The refund already standing on it, when one is. Present means nothing is sent for this payment. */
  standing: PaddleAdjustment | undefined;
}

/**
 * Read and check every payment, or refuse the whole request. **No write happens inside this.**
 *
 * A transaction Paddle does not know, or one it will not refund, refuses the request rather than becoming
 * an outcome: it is knowable in advance, and everything knowable in advance is decided while refusing is
 * still free. A store that cannot be *reached* raises `payments/provider_unavailable` from `paddleJson`
 * and is left to propagate, because nothing about the subscription is wrong and telling a customer their
 * refund was refused over a timeout is a true sentence about the wrong thing.
 */
async function check(purchases: readonly PaymentsPurchase[], options: PaddleRefundOptions): Promise<Checked[]> {
  const read = {
    credentials: options.credentials,
    environment: options.environment,
    transport: options.transport ?? paddleHttpFetch,
  };
  const checked: Checked[] = [];

  for (const purchase of purchases) {
    const transactionId = transactionIdOf(purchase);
    if (transactionId === null) {
      refuse(
        `Purchase ${purchase.id} names ${JSON.stringify(purchase.providerTransactionId)}, which is not a Paddle transaction. A refund attaches to a transaction, and a subscription is not one.`,
      );
    }

    const transaction = await readTransaction(transactionId, read, PADDLE_ADJUSTMENTS_INCLUDE);
    if (transaction === undefined) {
      refuse(`Paddle has no transaction ${transactionId}, so there is nothing on it to refund.`);
    }
    if (transaction.status !== "completed") {
      refuse(
        `Paddle reports transaction ${transactionId} as ${JSON.stringify(transaction.status)}, and only a completed transaction can be refunded. Nothing in this set was raised.`,
      );
    }

    checked.push({ purchase, transactionId, standing: standingRefund(transaction) });
  }

  return checked;
}

/** Paddle's status, as this package states it. An unmapped one is `unknown` — never a throw. */
function statusOf(stated: string | null | undefined): RefundRequestStatus {
  return (typeof stated === "string" ? REFUND_STATUS[stated] : undefined) ?? "unknown";
}

/**
 * Ask Paddle to refund these payments in full, and report what became of each.
 *
 * The report is **total** over the input — one outcome per purchase, in the order given — because a report
 * shorter than the set is what a silent partial looks like. See {@link RefundRequest}.
 */
export async function requestPaddleRefunds(
  input: RefundRequestInput,
  options: PaddleRefundOptions,
): Promise<RefundRequest> {
  const { purchases, reason } = input;

  if (purchases.length === 0) {
    // Not an empty report. "Nothing to refund, all done" is a sentence about somebody's money that
    // nobody asked for; a caller with nothing to refund has a refusal to render.
    refuse("No payment was named, so there is nothing to refund.");
  }
  if (purchases.length > MAX_PADDLE_REFUND_TRANSACTIONS) {
    refuse(
      `${purchases.length} payments were named and one request refunds at most ${MAX_PADDLE_REFUND_TRANSACTIONS}. A call that runs out of budget half way through is a partial refund nobody asked for, so the whole set is refused before anything is read.`,
    );
  }

  const checked = await check(purchases, options);
  const transport = options.transport ?? paddleHttpFetch;
  const outcomes: RefundRequestOutcome[] = [];
  let raised = 0;

  for (const one of checked) {
    if (one.standing !== undefined) {
      outcomes.push({
        outcome: "already_requested",
        purchaseId: one.purchase.id,
        adjustmentId: one.standing.id,
        status: statusOf(one.standing.status),
      });
      continue;
    }

    let answer: unknown;
    try {
      const response = await paddleJson(transport, "/adjustments", {
        what: `a refund on transaction ${one.transactionId} (this key needs the adjustment.write permission)`,
        apiKey: options.credentials.apiKey,
        environment: options.environment,
        method: "POST",
        body: {
          // The only action this module ever sends. `credit`, `chargeback` and the rest are Paddle's to
          // raise; a value here would be a second verb wearing this one's name and its own audit row.
          action: "refund",
          // The transaction's whole total. `partial` needs `txnitm_` ids nothing here holds, and an
          // amount on a bearer route is a self-service withdrawal.
          type: "full",
          transaction_id: one.transactionId,
          reason,
        },
      });
      answer = response?.data;
    } catch (error) {
      // **The line the whole design sits on.** With nothing raised, an error is the honest answer and the
      // more useful one. With an adjustment already in flight, throwing would tell the caller the refund
      // failed while the customer's money is on its way back — the silent partial, told backwards.
      if (raised === 0) throw error;
      outcomes.push({ outcome: "failed", purchaseId: one.purchase.id, reason: said(error, one.transactionId) });
      continue;
    }

    const parsed = PaddleAdjustment.safeParse(answer);
    if (!parsed.success) {
      // Paddle answered 2xx, so an adjustment may well exist and this build simply cannot read it. Before
      // the first write that is a shape change worth failing on; after it, losing the adjustment that
      // definitely does exist is the worse outcome.
      if (raised === 0) {
        throw new PaymentsProviderUnavailableError({
          detail: `Paddle answered the refund of transaction ${one.transactionId} in a shape this build cannot read.`,
        });
      }
      outcomes.push({
        outcome: "failed",
        purchaseId: one.purchase.id,
        reason: `Paddle answered the refund of transaction ${one.transactionId} in a shape this build cannot read, so whether one was raised is unknown. Check the transaction's adjustments at Paddle.`,
      });
      continue;
    }

    raised += 1;
    outcomes.push({
      outcome: "requested",
      purchaseId: one.purchase.id,
      adjustmentId: parsed.data.id,
      status: statusOf(parsed.data.status),
    });
  }

  // Parsed rather than returned raw: this crosses into a route that hands it to an audit trail and to a
  // browser, and every boundary in this package is validated. It also refuses an outcome list that lost
  // an entry, which is the one defect the shape exists to prevent.
  return RefundRequest.parse({ outcomes });
}

/**
 * What went wrong, in an operator's words, with anything key-shaped blanked.
 *
 * A reported reason lands in an audit trail and in a log, and the API key is in every request this module
 * makes. `paddleJson` has already put Paddle's own sentence in `detail` and redacted it once; this redacts
 * again rather than trusting that, because the cost of the second pass is nothing and the cost of the
 * assumption being wrong is a credential in a long-lived queryable table.
 */
function said(error: unknown, transactionId: string): string {
  const detail = (error as { payload?: { detail?: unknown } } | null)?.payload?.detail;
  const stated = typeof detail === "string" && detail !== "" ? ` ${redactPaddleSecrets(detail)}` : "";
  return `Paddle would not refund transaction ${transactionId}.${stated}`;
}
