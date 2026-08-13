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

/** The include the adjustment map needs, named once so a call site cannot spell it differently. */
export const PADDLE_ADJUSTMENTS_INCLUDE: readonly string[] = ["adjustments"];

/**
 * The permission each include this rail asks for demands of the key, so a refusal names what to grant.
 *
 * Paddle's permissions reference: *"Your key needs read permission for any entity added via the `include`
 * parameter"*, and a key without it gets `forbidden` (403). The OpenAPI spec says the same thing in
 * machine-readable form — `x-enum-permissions: {adjustments: ['adjustment.read']}` on this very query
 * parameter. A 403 whose message says only "Paddle refused" sends an operator to check the key itself,
 * which is the one thing that is not wrong.
 */
const INCLUDE_PERMISSIONS: Readonly<Record<string, string>> = { adjustments: "adjustment.read" };

/**
 * The transaction with this id, or `undefined` when Paddle has none.
 *
 * **An `include` is a permission demand, so it is asked for only by the caller that needs it.** Three of
 * this rail's four transaction reads — receipt verification, reconciliation, and the sweep's own
 * projection — want a status, a total and a `custom_data` stamp, all of which are on the transaction
 * itself. Only the adjustment map needs the array, because an adjustment says how much came off and never
 * what the original was: Paddle raises one adjustment per refund, so a transaction refunded in two goes
 * carries two, and only their sum tells a full refund from a partial one.
 *
 * An earlier build sent `include=adjustments` on every read and its docstring claimed *"a key without
 * adjustment-read permission simply gets no array back rather than a refusal"*. Paddle's own reference
 * says the opposite — see {@link INCLUDE_PERMISSIONS} — so that build made `adjustment.read` a
 * requirement of checking out, on a rail whose documentation tells adopters to scope keys narrowly. The
 * adopter documentation now states the requirement where it is real, and the refusal names it.
 */
export async function readTransaction(
  id: string,
  options: PaddleReadOptions,
  include?: readonly string[],
): Promise<PaddleTransaction | undefined> {
  const asked = include === undefined || include.length === 0 ? undefined : include.join(",");
  const needs = (include ?? [])
    .map((entity) => INCLUDE_PERMISSIONS[entity])
    .filter((permission): permission is string => permission !== undefined);
  const answer = await paddleJson(options.transport, `/transactions/${encodeURIComponent(id)}`, {
    what:
      asked === undefined
        ? `transaction ${id}`
        : `transaction ${id} with include=${asked}${needs.length === 0 ? "" : ` (this key needs the ${needs.join(" and ")} permission)`}`,
    apiKey: options.credentials.apiKey,
    environment: options.environment,
    query: asked === undefined ? undefined : [["include", asked]],
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
