---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
---

Quote a signed-in customer from the address they are charged from.

A customer is charged from their billing address. Paddle settles tax on the transaction's address, not on where the browser happened to be — and the pricing screen passed neither `address` nor `customerId`, so a returning customer read an IP-derived estimate while the authoritative answer sat on file at Paddle. In the United States that gap reaches 15%.

`@pithy-sh/payments/src/pricing/location` is now the one resolver. `resolvePriceLocation` takes what a caller knows about a visitor and picks the best source available — a Paddle customer, then a billing address, then the IP — and says which one it picked. `priceQueryFor` builds the request from it. `quoteIsEstimated` decides the label, from two facts rather than one: an unresolved tax, and a provisional location. Deriving that label from the postal code alone was right by accident, because Paddle resolves no postal code from an IP; an accident is not a rule.

The quoted figure and the charged figure now resolve location from the same row. `GET /payments/pricing` carries `quotedFrom` — the caller's own store customer, read through the same `accountFor` that `POST /payments/checkout` hands the rail as `customer_id`. A workers test quotes, buys, and compares the two.

The anonymous path is unchanged. A stranger is quoted from their IP, labelled `Estimated.`, and no round trip is made for a session that does not exist. A signed-in visitor's price refines once their customer resolves — the recalculation every checkout on the web does, promised in advance by the label rather than sprung at the card form.

Two gates ship with it, both stated as what must be true of the template tree rather than as a list of today's screens. No scaffolded screen may contain a money-shaped literal. Any screen that quotes must route both its query and its label through the resolver.
