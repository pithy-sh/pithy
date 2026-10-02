---
"@pithy-sh/payments": minor
---

A buyer following a payment link from Paddle now lands on an open checkout.

Paddle appends `?_ptxn=<transaction_id>` to a seller's Default payment link for the links it sends itself — past-due dunning mail, a manually-collected invoice, the payment-method-update link it mints for a subscription — and nothing read it. `usePaddleLink` does, and `GET /payments/checkout/resume` answers with the same handoff the minted path returns, so `usePaddleCheckout` opens it unchanged.

The resume route is unauthenticated, because the buyer following a dunning mail days later is usually signed out. It discloses nothing — the client token is publishable, the environment, display mode and success URL are config constants, and the transaction id is the caller's own — and it never reads the transaction from Paddle, so it cannot report whether an id exists.

In `inline` mode the Default payment link must point at a page that renders the frame container; `docs/paddle.md` says so where the link is set. `hosted` refuses, because the buyer is already on Paddle's own checkout.
