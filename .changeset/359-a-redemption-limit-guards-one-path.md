---
"@pithy-sh/payments": patch
---

`maxRedemptions` said it stopped a second use. It stops one of the two ways a code is used.

`DiscountTerms.maxRedemptions` described itself as "what actually stops a second use", and the advice an adopter takes from that is the dangerous half: *do not guard in your own record, the provider guards it.*

Measured against the Paddle sandbox on 2026-08-14, a 50% recurring discount minted with `usage_limit: 1` was applied through `PATCH /subscriptions/{id}` to one subscription and then to a second. Both succeeded and `times_used` stayed `0`. It moved to `1` only when a transaction billed under the code completed, after which `POST /transactions` naming it was refused — "Discount usage limit has been exceeded". Paddle's reference says a usage counts on "a checkout, transaction, or the initial application against a subscription"; the third clause did not hold.

So the limit guards the customer path and not the staff path. An adopter whose people comp by updating subscriptions rather than by sending customers to a checkout has no guard at all, and the failure is silent and gives money away. The `.describe()` now says that, with the measurement, and `docs/paddle.md` §14 carries it beside the charset and duration notes.

**No counter was added, and that is the decision rather than the omission.** A count kept here would be a second answer to a question the store already answers, and it would be wrong the first time a code is redeemed anywhere this deployment is not watching. What an adopter gets instead is a true sentence about where the limit bites, so they can keep their own record where it does not.
