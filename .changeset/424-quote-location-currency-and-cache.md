---
"@pithy-sh/payments": minor
---

The shared quote resolves a location, carries its currency, and caches where you tell it to.

`quotePlans` shipped in `#421` with one consumer, and the marketing site is not a demanding one: it quotes anonymous visitors and formats nothing itself. So the core it shares dropped two things the dashboard needs, and both were already present one layer down.

**It resolves a location now.** `quotePlans(setup, plans, { query })` takes the location half of a `PricePreview` request — `customerId`, `address`, `customerIpAddress`, `currencyCode`, `discountId` — and merges it into the query it builds. A quote has to resolve from the same Paddle row the charge will: without a `customerId`, a signed-in customer with an address on file was quoted from whatever network they happened to be on, and `priceSummary` marked the figure `estimated` because no postal code resolved. A hedged number that differs from the card charge is the exact defect that module exists to avoid.

**`PaddlePlanQuote` carries the currency.** `headline` is formatted by Paddle, so a screen rendering it needs nothing else; a caller formatting the figure itself had `preview.currencyCode` held one layer down and dropped, and `PriceSummary` has no currency either. It is `preview.currencyCode`, verbatim.

**A quote can be cached, and nothing about how is decided here.** Pass `cache: { key, store, ttlMs }` — a namespace, a store you name, and a lifetime you state. There is no default store, because a quote resolved from a `customerId` is one customer's price and `sessionStorage` and `localStorage` are the same interface with very different promises about a shared machine. There is no default lifetime, because Paddle's figures move — one recorded Japanese price came back ¥797 then ¥798 minutes apart — and a cached figure is a figure nobody re-checked. Two of the three parts warns to the console, names what is missing, and quotes from the network; a broken cache never fails a quote. A write clears that cache's own expired entries as it passes, because nothing reads a departed customer's key again — without it a dashboard on a shared machine keeps one entry per person who ever signed in until the quota fills and every write starts failing silently. The question is inside the entry's key, so one visitor cannot be handed another's answer and a sandbox answer cannot survive into production. A hit skips the Paddle.js load, which is the part a visitor waits for.

The browser build carries all of it, because one artifact serves the marketing site and a signed-in dashboard both: `data-paddle-customer`, and `data-paddle-cache` with `data-paddle-cache-store="local|session"` and `data-paddle-cache-ttl` in seconds. A `data-paddle-customer` that is not a `ctm_…` is dropped rather than refused — the opposite call to a placeholder price id, which still takes the whole tag down, because a wrong price is unrecoverable while a missing customer costs a visitor the estimate every anonymous visitor already sees.

The browser-import allowlist covers the four modules the artifact is built from. `paddlePrices.ts`, `paddlePricesTag.ts` and the iife entry compiled into an adopter's bundle without being on it.
