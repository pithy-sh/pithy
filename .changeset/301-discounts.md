---
"@pithy-sh/payments": minor
---

Apply a discount at checkout, report the rate it buys and when it ends, and mint one from a shape that says what it means.

`grep -rn "coupon\|promotion_code\|discount" packages/payments/src` returned nothing before this. Stripe supports coupons and promotion codes, Lemon Squeezy supports discounts, and the capability could express neither — so an adopter offering a startup rate, a launch discount or a comped first year had no path through it at all.

**Applying works with creation unimplemented, and that is a property rather than a coincidence.** `POST /payments/checkout` takes an optional `discountCode` and hands it to the store unchanged; an adopter whose codes are minted by hand in a provider dashboard is fully served by that half alone. Nothing here computes a discounted amount. The provider is the authority on what is owed, and a second calculation would be a second answer to the one question a customer checks against their card statement.

An invalid or expired code is refused as `payments/discount_invalid` (400) naming the code — never as a generic checkout failure. A customer told "something went wrong" concludes their card was declined and stops trying; one told their code was not accepted removes it and buys.

**`GET /payments/pricing` is the half that stops a bill changing unannounced.** It reports what the caller's own subscription pays now, what it pays once the discount ends, and the date. A capability that could apply a discount but not report its end date would have shipped the half that creates the surprise: from a customer's seat, a rate that silently lapses is indistinguishable from a billing error.

**`POST /payments/admin/discounts` mints one, from a normalized shape that names what things mean rather than mirroring whichever provider was implemented first.** That constraint is load-bearing, because the two stores agree on the concept and disagree on the fields in ways that are invisible until somebody is charged wrongly:

- **Duration is counted in billing periods** — what a customer experiences. Stripe counts *months*, so the Stripe rail multiplies by the plan's interval; Lemon Squeezy counts *periods*, so its rail passes the number through. `billingInterval` is therefore **required** on a repeating discount rather than assumed: on an annual plan, `12` is one year on one rail and twelve years on the other. A test pins an annual plan producing `144` for Stripe and `12` for Lemon Squeezy from one set of terms.
- **`redeemableUntil` stops a *claim*, never a discount already claimed.** It lands on Stripe's Promotion Code and not its Coupon — the same word one level up would end an existing customer's rate on the date — and on Lemon Squeezy's `expires_at`, which already means that.
- **A fixed amount in a currency the store does not sell in is refused at creation**, naming both. The store accepts it and fails at *redemption*, so the adopter who could fix it never sees the error and the customer who cannot does.

Creation sits behind `payments:discounts:create`, granted separately from the entitlement writes, and emits its own audit event: minting a discount is an administrative act with a cost attached. `GET /payments/admin/discounts` reads back what was issued behind its own narrower `payments:discounts:read` — a management client that can create a code and never see it leaves a pane computing *absent* rather than blocked, which no grant repairs (#247). Neither reaches a browser: what an adopter has issued is a commercial fact, and the client projection draws the same line here it draws for SKUs and the `grants` block.

The kit provides the verb; the adopter provides the policy. Who may be offered a code, what it is worth, where that offer is recorded and when it stops being advertised are commercial decisions with a company's pricing behind them.
