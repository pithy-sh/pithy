---
"@pithy-sh/payments": patch
---

A note a provider read produced no longer finishes a webhook row, and linking an account projects the purchases that were waiting for it.

Three rails derive their note from a call to the store — Play has no purchase under the token, Lemon Squeezy no longer knows the subscription, Paddle will not show the transaction an adjustment names. That answer can be a race, and finishing the row on it made the redelivery carrying the better answer a `duplicate`. A note now says where it came from, and only one the delivered bytes state is terminal.

An orphan got exactly one owner resolution, at the moment nobody could answer it. The account link is the signal no store redelivers on, so every path that writes a link now replays the rows abandoned for want of it. Stripe and Paddle can replay their own recorded payloads; the rails whose stored body is a signed blob are unchanged.
