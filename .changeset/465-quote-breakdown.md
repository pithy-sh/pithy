---
"@pithy-sh/payments": patch
---

A plan change quote states the halves each figure reconciles, so a person can arrive at it.

`update_summary` answers a net — *$48.83 to pay* — and a screen showing it beside a $18 price and a
$110 price shows a number no arithmetic on the page reaches. The honest reading available to somebody
looking at it was that the store had it wrong. It did not: $51.16 of the new plan over the days left,
less $2.33 of the old one already paid for them. Both figures come from the same summary the net does.

`SubscriptionChangeQuote` carries them now. `settles.madeUpOf` is the `{ charge, credit }` a settlement
reconciles; `recurring.madeUpOf` is the `{ beforeTax, tax }` a renewal does, so *$119.76 a month* can
say which part of it is tax. Both are on the wire in `PaymentsSubscriptionSettlement` and
`PaymentsSubscriptionQuote`, and both are **nullable** rather than optional.

**Null is a whole answer.** A store that stated the net and not its halves has said everything the
customer is being asked to agree to, and a rail that cannot state a half in full must not state it in
part. `quotedOrNull` never throws: a half with no currency, or a currency the other half does not
share, yields `null` for the pair rather than a guess or an error — which is why a quote that used to
render still renders, unchanged, everywhere the store is terse.

Nothing is computed from them and nothing checks them against the net. The moment this page did
arithmetic on a store's answer it would be claiming to have audited it.

Fixes #465
