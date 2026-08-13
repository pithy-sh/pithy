// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsPaddleCredentials } from "../../secret/registry";
import { type PaddleEnvironment, type PaddleHttpFetch, paddleJson } from "./api";
import { PaddleSubscription, PaddleTransaction } from "./objects";

/**
 * The reads this rail makes of Paddle: a transaction, and a subscription.
 *
 * Both return `undefined` rather than throwing on an absent object, because two callers with different
 * needs share them. The webhook parser reads a transaction to learn whether a refund covers its whole
 * total; the reconciliation pass reads one to find out what a purchase looks like now. For the first, an
 * absent transaction is a delivery this deployment cannot project; for the second it is the contract's
 * documented "the store no longer knows this purchase". Neither is a failure of the rail.
 *
 * A store that cannot be *reached* throws `payments/provider_unavailable`, which is what tells the
 * reconciliation Workflow to fail the step and retry, and what makes the webhook guard answer non-2xx so
 * Paddle redelivers.
 */

/** What a read needs: the credentials, which account, and the transport. */
export interface PaddleReadOptions {
  /** The rail's credentials. The API key is read at the point of need and never cached. */
  credentials: PaymentsPaddleCredentials;
  /** Which Paddle account to reach. */
  environment: PaddleEnvironment;
  /** The HTTP seam. */
  transport: PaddleHttpFetch;
}

/**
 * The transaction with this id, or `undefined` when Paddle has none.
 *
 * `include=adjustments` is asked for unconditionally, because the caller that most needs it — the
 * adjustment map — cannot tell a full refund from a partial one without it. Paddle raises one adjustment
 * per refund, so a transaction refunded in two goes carries two, and only their sum answers the question.
 * The include costs nothing on the paths that ignore it, and a key without adjustment-read permission
 * simply gets no array back rather than a refusal.
 */
export async function readTransaction(id: string, options: PaddleReadOptions): Promise<PaddleTransaction | undefined> {
  const answer = await paddleJson(options.transport, `/transactions/${encodeURIComponent(id)}`, {
    what: `transaction ${id}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    query: [["include", "adjustments"]],
    absentOn404: true,
  });
  if (answer === undefined) return undefined;
  const parsed = PaddleTransaction.safeParse(answer.data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The subscription with this id, or `undefined` when Paddle has none.
 *
 * `include=next_transaction,recurring_transaction_details` is asked for by the pricing read, which needs
 * what the next invoice comes to and what it becomes once a discount lapses. It costs nothing on the
 * paths that ignore it, and asking twice would be two round trips for one question.
 */
export async function readSubscription(
  id: string,
  options: PaddleReadOptions,
  include?: readonly string[],
): Promise<PaddleSubscription | undefined> {
  const answer = await paddleJson(options.transport, `/subscriptions/${encodeURIComponent(id)}`, {
    what: `subscription ${id}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    query: include === undefined || include.length === 0 ? undefined : [["include", include.join(",")]],
    absentOn404: true,
  });
  if (answer === undefined) return undefined;
  const parsed = PaddleSubscription.safeParse(answer.data);
  return parsed.success ? parsed.data : undefined;
}
