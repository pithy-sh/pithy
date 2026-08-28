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
| `GET /payments/subscription` | Where the caller's own subscription stands, read live from the store | bearer · session |
| `POST /payments/subscription/preview` | What moving to one catalog product would cost, before anything is committed | bearer · session |
| `POST /payments/subscription/change` | Move the caller's own subscription onto one catalog product | bearer · session |
| `POST /payments/subscription/cancel` | Stop it renewing — today, or at the end of the paid period | bearer · session |
| `POST /payments/subscription/keep` | Withdraw a scheduled cancellation | bearer · session |
| `POST /payments/subscription/refund` | Ask the store to refund the payments made on it | bearer · session |
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

### What `GET /payments/subscription` answers

The read that ships before the four verbs beside it. A capability that can cancel a subscription and cannot report the cancellation has shipped the half that creates the support ticket, which is #247 in miniature.

```json
{
  "subscription": {
    "productId": "team_monthly",
    "status": "active",
    "currency": "usd",
    "currentPeriodEndsAt": "2026-09-15T11:42:21.789Z",
    "nextBilledAt": null,
    "scheduledChange": { "action": "cancel", "effectiveAt": "2026-09-15T11:42:21.789Z", "resumesAt": null },
    "nextEvent": { "kind": "ends", "at": "2026-09-15T11:42:21.789Z" }
  }
}
```

`subscription` is null when the caller holds none, and when the store has nothing to say about the row it holds. That is a fact rather than a failure, and it is deliberately not a 404: a 404 would make this route an existence oracle and would read, to a screen, exactly like a Worker that could not be reached.

**A holder with more than one live subscription gets `payments/subscription_change_refused` (409), on all five routes.** Null would say they hold none and picking one would render a plan beside a button that ends a different one, so the server says there are two and stops. Send them to the billing portal.

| Field | What it is |
| --- | --- |
| `productId` | The catalog product this subscription is for — the key in `products`. Look the display name up from it; a name copied onto every response goes stale the day it is changed |
| `status` | The normalized status, never a store's own. **It does not say whether the subscription is ending** |
| `currency` | What it bills in, lowercase, or null when the store did not state one. Here to format the price `GET /payments/pricing` carries, not to carry a price |
| `currentPeriodEndsAt` | When the period already paid for runs out, ISO-8601. Null while trialing or paused, which are the states with no billing period |
| `nextBilledAt` | When the next charge falls due, or null when none is going to. **Null is neither canceled nor broken** |
| `scheduledChange` | The change waiting to land, or null. `action` is `cancel`, `pause` or `resume`; `effectiveAt` is when it happens; `resumesAt` is when a paused subscription comes back, or null |
| `nextEvent` | What happens next and when, already resolved — `{ "kind": "renews" \| "ends" \| "pauses" \| "resumes", "at": "…" }`, or `{ "kind": "unknown", "at": null }` |

**Render `nextEvent`, not `status`.** The subscription above is one somebody canceled. Paddle reports it as `active`, with no cancellation date and a blank next billing date (recorded against the sandbox, 2026-08-28): two of the three say the subscription is fine and the third says nothing at all. The day it ends exists only on `scheduledChange.effectiveAt`. A screen that reads the status tells a customer who canceled that they will be billed again, and `nextEvent` is that precedence resolved on the server so no client has to rediscover it.

**The three writes answer `{ "subscription": … }` with the same object, never null** — each resolved a subscription before it ran — and `POST /payments/subscription/preview` answers `{ "quote": … }` instead: what settles today, what settles on the next invoice, and what the subscription pays afterwards. Three separate facts, because a deferred downgrade has three: the recorded one settles *nothing* today and still owes the customer 65.58, on an invoice a month out. A quote is rendered, confirmed and discarded — never stored.

### What `POST /payments/subscription/refund` does, and does not

It **asks**. It does not refund. Paddle holds most live refunds at `pending_approval` until a person there reviews them, so the route answers `{ "refund": { "outcomes": [ … ] } }` — one entry per payment, each `requested`, `already_requested` or `failed`, with a `status` on the first two that is `awaiting_review`, `approved`, `rejected`, `reversed` or `unknown`. **None of those means the money has arrived**, `approved` included: that is a decision, not a settlement, and the settlement reaches you as a webhook.

Nothing is revoked here. Not the entitlement, not the purchase row, not a projection — the subscriber keeps what they paid for until the store approves the refund and the webhook says so, because a refund the store then rejects would otherwise have left them with neither the money nor the product.

**Refunds attach to a payment, not to a plan**, so this acts on a set. A customer who joined on one plan, upgraded mid-period and canceled has paid twice, and a policy that owes them their money owes both. The report is total over that set: one entry per payment, always, so a caller counting entries and a caller counting their own payments get the same number. Everything knowable in advance refuses the whole request and raises nothing; once one refund exists, every remaining failure is an entry rather than an error, because an error over a state where money is already moving is a partial told backwards.

**The 14-day window is not here, and no window is.** How long a customer has to ask is your commercial policy, with your company behind it. The kit makes the refund possible and hard-codes no number; your screen decides which button exists and when.

The body is empty and there is no amount anywhere: every refund raised is for a payment's whole total. A partial refund needs the store's own line-item ids, which this capability does not hold, and an amount on a bearer route is a self-service withdrawal.

**None of the six accepts a subscription, a price, or a rail.** `change` and `preview` take one field, `productId`, and the route resolves the store's own price from the catalog; `cancel` takes `timing`, which is `now` or `at_period_end` in the customer's own terms rather than the store's; `keep` and `refund` take no body at all. A body naming a price would move a customer onto a plan the project does not sell, and a body naming a subscription would move somebody else's — so neither is refused by a check, and both are unreachable because there is nowhere to write them.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
