// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Two `custom_data` objects a browser wrote onto real Paddle transactions, recorded from the live sandbox.
 *
 * Not invented. Both were produced on 2026-08-13 by a page holding nothing but a publishable client token,
 * driving `Paddle.Checkout.open` and paying with `4242 4242 4242 4242`; both are what Paddle stored and
 * handed back from `GET /transactions/{id}` afterwards. That distinction is the point of the file: a
 * forgery a test author typed proves the reader agrees with the author, and a forgery Paddle stored proves
 * the attack exists.
 *
 * They matter because #309's design rested on the opposite belief — that `custom_data` could only be
 * written by the server, so an ownership stamp needed no proof. It rested on that belief being true of the
 * `transactionId` form in particular. **It is true of neither.**
 */

/**
 * The `items[]` forgery: a checkout the page opened for a price the page chose, stamped by the page.
 *
 * Recorded from `txn_01kzybmw15rve4bhj3zsbf1k5d`, which Paddle recorded with `origin: "web"` and a paid
 * total of `544`. No server was involved at any point. The `pithy_` key names are exported constants in an
 * open-source package and the environment is one of three, so an attacker guesses nothing here — which is
 * why the third key exists and why it is a MAC.
 */
export const BROWSER_ITEMS_FORGERY: Record<string, unknown> = {
  pithy_env: "prod",
  pithy_user: "victim",
  pithy_ref_proof: "0000000000000000000000000000000000000000000000000000000000000000",
};

/**
 * The overwrite: a checkout opened for a transaction **the server created and stamped**, whose stamp the
 * browser replaced on its way through.
 *
 * Recorded from `txn_01kzybt89pnvvnwgkabefsjy2z`. The server created it with
 * `{ pithy_user: "server-owner", pithy_env: "prod", pithy_ref_proof: "aa…aa" }`; the page called
 * `Paddle.Checkout.open({ transactionId, customData: { … } })` and paid, and this is what the transaction
 * carried afterwards. Paddle kept `origin: "api"`, so even *that* field does not distinguish the two.
 *
 * **This is the measurement that settles the issue's open question.** Choosing `transactionId` over
 * `items[]` is still right — it fixes the price and the buyer, which a page must never name — but it buys
 * nothing at all for `custom_data`. The stamp is protected by the MAC and by nothing else, on either form.
 */
export const BROWSER_OVERWROTE_SERVER_STAMP: Record<string, unknown> = {
  pithy_env: "prod",
  pithy_user: "attacker",
  pithy_ref_proof: "bb",
};
