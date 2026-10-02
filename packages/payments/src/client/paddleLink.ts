// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { isPaddleTransactionId } from "../data/paddleIds";

/**
 * The query parameter Paddle appends to a seller's **Default payment link**.
 *
 * Named once, because Paddle does not document it as stable and a literal at two call sites is how one of
 * them survives a rename. This is the thing to grep for if it ever moves.
 */
export const PADDLE_LINK_PARAM = "_ptxn";

/**
 * The transaction Paddle put in this page's URL, or null.
 *
 * **Paddle's own links are the ones that arrive here**, not any this kit opened: a past-due dunning mail,
 * a manually-collected invoice's pay link, the payment-method-update link Paddle mints for a subscription.
 * Each is the seller's *Default payment link* with `?_ptxn=<transaction_id>` on the end, and the contract
 * is that the page it lands on opens a checkout for that transaction.
 *
 * **Null is the ordinary answer and is not a failure.** Every page this is called on is loaded without a
 * `_ptxn` almost every time, so an absent parameter reads as "nothing to resume" and a screen renders
 * exactly as it did before this existed. A malformed one reads the same way, which is the second half of
 * the point: the value comes from outside, from a URL, from somebody who may not be signed in, and it is
 * about to be sent to a route and then handed to `Paddle.Checkout.open`. The only thing that makes it safe
 * to pass on is that it is shaped like a transaction id — so anything else is null rather than an error
 * worth telling a buyer about, because a buyer cannot act on it and an attacker already knows.
 *
 * The shape check is {@link isPaddleTransactionId}, which is the rail's own and is shared rather than
 * copied. Takes a search string rather than reading `location` itself, so this is a pure function and the
 * hook that owns the browser is the only thing that needs one.
 */
export function readPaddleLinkTransaction(search: string): string | null {
  // `URLSearchParams` takes either spelling, so a caller may pass `location.search` — which carries the
  // `?` — or a string it assembled without one, and neither has to be normalized first.
  const value = new URLSearchParams(search).get(PADDLE_LINK_PARAM);
  // Not trimmed, deliberately. A padded id is somebody's broken link or somebody's probe, and silently
  // repairing it would mean this function and the route disagreed about what the id was.
  return value !== null && isPaddleTransactionId(value) ? value : null;
}
