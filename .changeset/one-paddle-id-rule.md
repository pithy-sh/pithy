---
"@pithy-sh/payments": patch
---

Paddle's transaction and subscription ids have one definition each, and every site in the rail reads it.

Five places decided what a Paddle id was and no two agreed. `verify.ts` held a pattern; `refund.ts`, `refresh.ts` and `subscription.ts` each asked for a prefix instead, which accepts the prefix with nothing after it and an alphabet Paddle does not issue. So one string was a transaction in one module and not one in another. All of them read `isPaddleTransactionId` and `isPaddleSubscriptionId` now, and a sweep keeps those two the only answer.

What this changes for a stored purchase: a `providerTransactionId` holding a bare prefix, or an id in an alphabet Paddle never issues, used to cost a round trip and come back refused on the store's 404. Reconciliation and the pricing read now answer "nothing to say about this purchase" without asking — the same answer they already gave a prefix they did not recognize — and a refund refuses the row by name rather than by Paddle's reply. Nothing Paddle sends can reach those branches, because the column is only ever written from Paddle's own payloads and the one route that takes an id from outside already read the pattern, so this is reachable only by a row somebody wrote by hand.
