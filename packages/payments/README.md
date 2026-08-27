# @pithy-sh/payments

Three payment rails — Apple, Google, Stripe — resolving to one cross-rail entitlement, in your own Worker and your own D1.

Buy Pro on iOS, be entitled on the web. That resolution is the whole product, and it is the same one **[RevenueCat](https://www.revenuecat.com)** built a very good business on — their SDKs, their store-quirk coverage and their dashboards are genuinely ahead of this package. The honest difference is not the feature list. It is **where the purchase history lives**: RevenueCat is a hosted data plane holding your customers' transactions, and this is five tables in a D1 you own, written by a Worker you deploy.

```sh
pithy add payments
```

**Documentation: [pithy.sh/docs/capabilities/payments](https://pithy.sh/docs/capabilities/payments).** Overview, adding it, using it, and the reference: product versus entitlement, entitlement resolution, webhooks and replay. Selling on each rail is a guide apiece under [pithy.sh/docs/build/money](https://pithy.sh/docs/build/money/sell-on-the-app-store).

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Routes

| Route | Purpose | Verification |
| --- | --- | --- |
| `POST /payments/purchases` | Submit a receipt or signed transaction for verification | bearer · session |
| `GET /payments/entitlements` | The caller's own resolved entitlements | bearer · session |
| `POST /payments/restore` | Restore Purchases — rebind store history to the caller | bearer · session |
| `GET /payments/pricing` | What the caller's own subscription pays, and when that changes | bearer · session |
| `POST /payments/checkout` | Create a checkout, on Stripe, Lemon Squeezy or Paddle | bearer · session |
| `POST /payments/portal` | Create a billing-portal session for the caller's own account | bearer · session |
| `POST /payments/webhooks/apple` | App Store Server Notifications V2 | signed-webhook |
| `POST /payments/webhooks/google` | Play Real-time Developer Notifications, via Pub/Sub push | signed-webhook |
| `POST /payments/webhooks/stripe` | Stripe events | signed-webhook |
| `POST /payments/webhooks/lemon-squeezy` | Lemon Squeezy events | signed-webhook |
| `POST /payments/webhooks/paddle` | Paddle events | signed-webhook |
| `POST /payments/admin/discounts` | Mint a discount code at one store | control-plane: `payments:discounts:create` |
| `GET /payments/admin/discounts` | The discount codes this project has issued | control-plane: `payments:discounts:read` |
| `POST /payments/entitlements/grant` | Comp or repair an entitlement | control-plane: `payments:entitlements:grant` |
| `POST /payments/entitlements/revoke` | Take one back | control-plane: `payments:entitlements:revoke` |
| `GET /payments/admin/catalog` | What this project sells, and the keys it comps by hand | control-plane: `payments:catalog:read` |
| `GET /payments/admin/purchases` | The purchase log, paged | control-plane: `payments:purchases:read` |
| `GET /payments/admin/subscriptions` | The purchases that renew | control-plane: `payments:subscriptions:read` |
| `GET /payments/admin/entitlements` | The entitlement model, paged | control-plane: `payments:entitlements:read` |
| `GET /payments/admin/entitlements/:subjectType/:subjectId` | One subject's entitlements | control-plane: `payments:entitlements:read` |
| `GET /payments/admin/reconcile-runs` | The reconciliation passes this deployment has run | control-plane: `payments:reconcile:read` |

**Every route this capability registers is in that table, and a test holds it there.** The management reads shipped without rows for long enough that the next person to add one withheld theirs too — a table missing four peers reads as complete, so one more row would have read as a lie. `routeContract.test.ts` now parses this table and compares it against the real registrations in both directions, which makes the omission a failing build rather than a judgment call.

That gate checked the method and the path and nothing else, so a response could change shape under a row that still read as correct — which is how `quotedFrom` shipped undescribed. It now also holds `GET /payments/pricing`'s response envelope against the section below, field by field.

### What `GET /payments/pricing` answers

Two independent facts about one caller, siblings rather than one nested in the other, and each is null on its own terms.

```json
{
  "pricing": {
    "currency": "USD",
    "currentAmountMinor": 500,
    "listAmountMinor": 1000,
    "discountCode": "LAUNCH50",
    "discountEndsAt": "2026-09-01T00:00:00.000Z"
  },
  "quotedFrom": { "rail": "paddle", "providerAccountId": "ctm_01hv8wptq8987qeep44cyrewp9" }
}
```

`pricing` is null when no rail can price a subscription this caller holds — including when they hold none. When it is there it carries five fields, all nullable, and none of them is computed here: every amount is the store's own figure, because nothing in this package multiplies a price by a percentage.

| Field | What it is |
| --- | --- |
| `currency` | The currency both amounts are in |
| `currentAmountMinor` | What the next invoice comes to under any discount |
| `listAmountMinor` | What it comes to once the discount ends |
| `discountCode` | The code in force, or null at list price |
| `discountEndsAt` | When the rate changes, ISO-8601, or null — which is either no discount or one that runs forever. Read it beside `discountCode` to tell which |

**`quotedFrom` names the store customer a quote and a charge must both resolve from.** It is the caller's own row in the provider-account map, which is the same row `POST /payments/checkout` hands the rail as `customer_id` — so the figure quoted and the figure charged cannot resolve location differently. `ctm_…` is an identifier, not a credential: it names a Paddle customer and authorizes nothing, and Paddle's `PricePreview` reads a price with it and the publishable client token, which is the pair Paddle publishes for exactly this. The route is `requireAuth()` and answers only about its own caller, so nobody learns anybody else's.

A browser reads three states off it, and they are not the same answer:

| What arrives | What it means | What to quote from |
| --- | --- | --- |
| the field is absent | the Worker is older than the bundle asking it | the IP, labeled an estimate |
| `null` | no store holds a customer for this caller yet — the ordinary state of somebody who has not bought anything | a billing address you hold, else the IP |
| `{ "rail": "paddle", "providerAccountId": "ctm_…" }` | the store customer this caller is charged as | that customer |

`rail` is `paddle` today and is on the wire rather than assumed, because Paddle is the rail that quotes in a browser and a reader that skipped the check would price a Stripe customer id as a Paddle one. `providerAccountId` is that store's own customer id, and it is the same value this caller's checkout is charged against. `readPaddleCustomer` in `src/pricing/visitor.ts` refuses all three of the other shapes, and refuses a hostile one the same way.

**An address supersedes an IP, and which one you got is a fact the screen has to state.** A customer is charged from their billing address — Paddle settles tax on the transaction's address, not on where the browser happened to connect from. `resolvePriceLocation` in `src/pricing/location.ts` is the one resolver, and its precedence is authority rather than convenience:

| `source` | Where it came from | Is it the charge? |
| --- | --- | --- |
| `customer` | `quotedFrom.providerAccountId`. Paddle prices from the address it holds, which is the address the checkout charges | Yes. The only one that is not a guess |
| `address` | a billing address you hold and Paddle does not | Closer than the network, still not proof — the buyer may enter another at the card form |
| `ip` | nobody said. Paddle resolves the country from the browser's own connection | No. Right for a marketing page a stranger is reading, and an estimate every time |

`location.provisional` is true exactly when the source is `ip`, and `quoteIsEstimated(location, taxUnresolved)` is what a screen labels from — two independent reasons, either one enough. So a signed-in visitor's price refines: the first render quotes from the IP and says `Estimated.`, and the second supersedes it from the customer `quotedFrom` named. That is the recalculation every checkout on the web performs, and the only thing that would make it a broken promise is a first figure that did not admit what it was. In the United States the gap between the two reaches 15%.

**`currentAmountMinor` and `listAmountMinor` are not divisible by 100.** They are the store's own integers in the currency's smallest unit, and how many decimal places that unit has is a property of the currency rather than a constant: `500` is $5.00 in USD and ¥500 in JPY, and Korean won and Chilean pesos are the same story. **Read them beside `currency` or not at all.** Where the store hands you a rendered total — `PricePreview`'s `formattedTotals` and `formattedUnitTotals` — pass it through byte for byte; it already carries the currency's decimals, symbol and separators. Where you must work from the integers, take the scale from the currency (`Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().minimumFractionDigits`) and never from a literal. A `/ 100` in a consumer is wrong in every zero-decimal market it reaches, and wrong silently.

**This section stays here.** `src/http/routeContract.test.ts` parses that table and compares it against the real registrations in both directions, holds every control-plane scope the guards demand to it, and holds `GET /payments/pricing`'s response envelope to the field table above — field by field. It is specification, not a summary, and a copy of it on the site would be the second list that drifts.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
