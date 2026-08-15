---
"@pithy-sh/payments": patch
---

Describe `quotedFrom`, and make a response-shape change fail the build.

`GET /payments/pricing` gained `quotedFrom` and no document said so. The Routes table's gate checked the method and the path, so the row stayed true while the envelope under it changed — and an adopter had already built a quote seam on the field.

The README now carries the response in full: `quotedFrom`'s three states and what each means, the supersession rule, and the resolver's precedence. A billing address is authoritative because Paddle settles tax on the transaction's address; an IP is an estimate and is labelled one; `customer` beats `address` beats `ip`, and `provisional` is true exactly when the source is the IP. `docs/paddle.md` says the same where it covers the pricing seam, in place of a paragraph that predated the resolver.

`currentAmountMinor` and `listAmountMinor` are documented as what they are: the store's integers in the currency's smallest unit, where the number of decimals is a property of the currency. `500` is $5.00 and ¥500. Both documents say to read them beside `currency`, take the scale from the currency, or pass a rendered total through untouched — and that `/ 100` is wrong in every zero-decimal market, silently.

`routeContract.test.ts` now holds `GET /payments/pricing`'s envelope against the README field by field, one level into the objects nested on it. A field added to the response and not to the document is a failing build. The list of envelopes it covers is frozen, and the reason it is not every route is written down beside it.
