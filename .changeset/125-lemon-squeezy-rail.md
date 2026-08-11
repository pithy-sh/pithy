---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
"@pithy-sh/cli": minor
---

Sell through Lemon Squeezy. A fourth payments rail — hosted checkout, the customer portal, signed webhooks, and reconciliation — resolving to the same entitlements as Apple, Google, and Stripe, with the merchant of record handling your tax.

Apple, Google, and Stripe all leave the adopter as merchant of record: you own the tax registration, the VAT thresholds, the invoices, and the chargebacks. Lemon Squeezy owns all of it. That is the whole reason to reach for this rail, and it is a commercial difference rather than a technical one — the entitlements it produces are the same entitlements, resolved by the same writer.

`rails.lemonSqueezy` turns it on, a product carries `lemonSqueezy: { variantId }`, and the credential bundle gains an optional `lemonSqueezy` block with `apiKey`, `webhookSecret`, and `storeId`. `POST /payments/webhooks/lemon-squeezy` takes the deliveries. `/checkout` and `/portal` now pick a rail from the product's declared blocks rather than assuming Stripe, and a product sold on both takes a `rail` field — which a client may name, because a rail decides who takes the money and not how much or on whose behalf.

**Two things about this store are unlike the other three, and both are visible in your data.** Lemon Squeezy numbers each object type from one, so ids are namespaced in `provider_transaction_id` — `subscription:90001`, `subscription_invoice:8001`, `order:7001` — because a bare id would fuse an order and an invoice into one row. And it splits money from subscription state at the source, with no latest-invoice pointer to join them by, so a subscription writes one `role = 'state'` row carrying access and one `role = 'charge'` row per billing invoice carrying the money. Only `charge` rows fulfil a `grants` clause, so N renewals credit exactly N times.

`role` is new on `pithy_payments_purchases` and defaults to `charge`, which is what every other rail writes for every row.

Its webhook signature is a bare HMAC over the received bytes with no timestamp, so there is no freshness window to enforce and the verifier takes no clock — replay protection rests entirely on the existing `UNIQUE (rail, providerEventId)` insert. A refund revokes: Lemon Squeezy issues them on its own for a chargeback or a tax dispute, and the entitlement goes back with the money. A store shared between `dev` and `staging` is fenced by an environment stamp the checkout writes and the rail reads back, so one deployment never projects another's purchases.

There is no client-submittable receipt. Lemon Squeezy order ids are sequential integers, so `verify` refuses rather than letting any authenticated caller claim an order by counting; purchases land through the webhook alone, and a return page shows a pending state instead of posting a receipt.
