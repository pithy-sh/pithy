# Paddle

Wiring Paddle into `@pithy-sh/payments`. Step by step.

Paddle is the **merchant of record**, like Lemon Squeezy and unlike Stripe. It is the seller on your customer's statement, it calculates and remits sales tax and VAT worldwide, it issues the invoices, it runs dunning, and it absorbs the chargebacks. What it adds that a redirect-only rail cannot is **Paddle.js**: checkout opens as an overlay over your own page or inline inside it, and the customer portal hands back authenticated links to a specific subscription's cancel and payment-method screens.

Paddle **Billing**, not Paddle Classic. `api.paddle.com` in production, `sandbox-api.paddle.com` in sandbox, with `Paddle-Version: 1` pinned on every request.

## Why this part is manual

Everything below is created in the [Paddle dashboard](https://vendors.paddle.com) by a human with access to your account. Pithy cannot provision it: prices are commercial decisions, and a notification destination's signing secret is chosen once and shared with exactly one deployment. One-time setup per environment. Everything after it is config.

## 1. Two accounts, and they are genuinely separate

Paddle Billing partitions sandbox from live by **account**, not by a flag on an object. Separate host, separate API key, separate client token, separate notification destinations, separate catalog. So a price id from your sandbox does not exist in live, and there is no `mode` field on a transaction that could tell you which one you are looking at.

That is why `paddle.environment` is config and why it decides both which host the rail reaches and which environment every purchase row is recorded under. A sandbox-configured deployment cannot write a production row, and a sandbox purchase never grants a production entitlement.

## 2. Create your products and prices

Under **Catalog** → **Products**, create a product and give it a **price**. The price carries the amount, the interval and the trial, so the **price id** — `pri_01hv8w…` — is what goes in `pithy.config.ts`, exactly where Stripe's `priceId` sits.

```ts
payments({
  rails: { paddle: true },
  paddle: {
    clientToken: "test_1234567890abcdef",
    environment: "sandbox",
    checkout: "overlay",
    successUrl: `${PUBLIC_ORIGIN}/thanks`,
  },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      paddle: { priceId: "pri_01hv8w…" },
    },
  },
});
```

The catalog is the only place a price id appears. Gating code names `pro`.

A price id is **publishable** by design — it is what a transaction and `Paddle.Checkout.open` both name — so it may reach a browser. So is the client token. The API key and the notification destination's signing secret never do; they live in the secrets store.

## 3. Set a default payment link — before anything else

Under **Checkout** → **Checkout settings**, set a **default payment link**.

This is not a nicety and it is not hosted-mode-only. Without it Paddle refuses to create a transaction **account-wide**:

> Cannot create a transaction or open a checkout as no default payment link has been set for this account. Set in the Paddle dashboard, then try again.

Verified live. Every checkout mode creates the transaction server-side, so overlay and inline are blocked by exactly the same refusal. Point it at your own domain — Paddle only uses it to construct the hosted URL, which `checkout: "hosted"` returns and the other two modes ignore.

`pithy doctor` asks the same question, so this is caught before a buyer finds it.

## 4. Choose a checkout mode

```
paddle.checkout: "overlay" | "inline" | "hosted"
```

The server does the same thing in all three: `POST /transactions` with the price from your catalog, your buyer's Paddle customer when they have one, the ownership stamp, and the resolved discount. What differs is only the handoff.

- **`overlay`** and **`inline`** return `{ kind: "paddle", transactionId, clientToken, environment, displayMode }`. There is nothing to navigate to — the checkout opens over or inside your own page — so your screen calls `Paddle.Checkout.open` with what it was handed.
- **`hosted`** returns `{ kind: "redirect", url }`, and your screen navigates there. `transaction.checkout.url` is null when no default payment link is set, and the rail raises `payments/rail_not_configured` naming that setting rather than sending a buyer nowhere.

The return type is a union across every rail. Stripe and Lemon Squeezy return the `redirect` member, unchanged. A screen narrows on `kind`, which is a compile error where it is missing rather than a navigation to an empty string.

## 5. Create the API key

Under **Developer tools** → **Authentication**, create a key. `pdl_sdbx_apikey_…` in sandbox, `pdl_live_apikey_…` in live.

It needs, at minimum:

| Permission | For |
|---|---|
| `transaction.write` | creating the checkout transaction |
| `transaction.read` | verifying a submitted `txn_…`, and reading a refunded transaction's total |
| `subscription.read` | reconciliation, and the pricing read |
| `customer_portal_session.write` | the customer portal |
| `discount.read` | resolving a code at checkout |
| `discount.write` | minting a code, if you use that half |
| `notification.read` | the events sweep |

**`customer_portal_session.write` is the one to check twice.** Without it Paddle returns a portal session with no authenticated URLs and your subscriber lands on a sign-in page instead of their billing.

## 6. Create the notification destination

Under **Developer tools** → **Notifications**, add a destination pointing at `https://<your-worker>/payments/webhooks/paddle`, one per environment. If you moved `basePath`, register the URL to match.

Subscribe it to exactly these:

```
transaction.paid  transaction.completed  transaction.payment_failed
transaction.past_due  transaction.canceled  transaction.updated
transaction.revised  transaction.billed
subscription.created  subscription.activated  subscription.resumed
subscription.trialing  subscription.past_due  subscription.paused
subscription.canceled  subscription.updated  subscription.imported
adjustment.created  adjustment.updated
```

Anything else is authentic, recorded, and projects nothing — including a type Paddle ships after this package did. That is deliberate: a throw would make Paddle redeliver it for three days.

**Do not subscribe `api_key.*` or `client_token.*`.** A `client_token.created` payload carries a live client token, unredacted, and every authentic delivery is stored whole in `pithy_payments_webhook_events`.

Copy the destination's secret key — `pdl_ntfset_…` — and store it beside the API key:

```
pithy secrets set payments-provider-credentials
```

```json
{
  "paddle": {
    "apiKey": "pdl_sdbx_apikey_…",
    "webhookSecret": "pdl_ntfset_…"
  }
}
```

The client token is **not** here. It is publishable by design, it lives in `pithy.config.ts`, and putting it behind the secrets store would suggest verification depended on its secrecy. It does not.

## 7. Signature verification, and the window

`Paddle-Signature: ts=1770000000;h1=5257a8…`. Elements split on `;`, key and value split on `=`, and the signed payload is the timestamp, **a colon**, and the exact received body. HMAC-SHA256, hex, keyed with the destination's secret.

That is two characters different from Stripe's scheme — which splits on `,` and joins with `.` — and the two characters are the whole verification. This rail therefore carries its own verifier rather than reusing core's, and `rails/paddle/signature.ts` says so at the top.

**The freshness window defaults to 300 seconds, not the 5 Paddle's own SDKs use.** Replay protection here is `UNIQUE (rail, providerEventId)` over `evt_…`, which is absolute: a captured delivery replayed a year later is refused because its event id is already recorded. A five-second window adds nothing to that and converts ordinary clock skew between a Cloudflare edge and Paddle into a dropped renewal. Set `paddle.webhookFreshnessSeconds` if you want Paddle's number.

Paddle re-signs each retry with a fresh `ts`, so the window does not silently reject retries. Sandbox retries three times over fifteen minutes; live retries sixty times over three days, with a five-second response deadline.

## 8. Ownership, and the part that is not optional

`createCheckoutSession` stamps three things into the transaction's `custom_data`:

```json
{
  "pithy_user": "<the authenticated buyer>",
  "pithy_env": "<this deployment's ENVIRONMENT>",
  "pithy_ref_proof": "<HMAC-SHA256 over (env, user), keyed with the webhook secret>"
}
```

The third is the only one that means anything, and here is why. `Paddle.Checkout.open({ items: [{ priceId, quantity }], customData: {…} })` is a first-class supported call needing nothing but the publishable client token — the token this rail ships to every browser that loads your paywall. So a stranger can write `pithy_user` and `pithy_env`: the key names are exported constants in an open-source package and the environment is one of three values.

What they cannot write is a MAC keyed on your notification destination's secret. So the rail honours a stamped reference only when the proof verifies, and refuses it otherwise. A delivery with no stamp at all — a transaction you created by hand in the dashboard — is not fenced out; it simply binds nobody.

## 9. The dev-to-staging caveat

`dev` is not publicly routable, so a dev checkout's webhooks land at **staging**. Both point at one Paddle sandbox, and a sandbox has exactly one set of notification destinations. **A delivery stamped for another environment is the normal case on this rail, not an anomaly.**

Each instance checks every delivery against its own `ENVIRONMENT`. One stamped for somebody else is authentic, is recorded in `pithy_payments_webhook_events`, projects nothing, grants nothing, **emits no audit warning**, and returns 200. No warning deliberately: on a shared sandbox it would fire on most deliveries and train you to ignore the channel.

So a dev purchase reaches your database through `verify` rather than through a webhook. The overlay's `checkout.completed` callback hands the browser a `txn_…`; your screen posts it to `POST /payments/purchases`; the rail reads the transaction and binds it — refusing when the transaction's own proven `custom_data.pithy_user` names somebody other than the authenticated caller. That is why `verify` exists on this rail where Lemon Squeezy refuses one: the id is a pointer, and the stamp is the authorization.

## 10. Paddle.js and your Content Security Policy

Paddle.js is a **remote script from Paddle's CDN**, and it is the first third-party script this kit has ever asked you to load. Your CSP has to allow it:

```
script-src  https://cdn.paddle.com
connect-src https://*.paddle.com
frame-src   https://*.paddle.com
img-src     https://*.paddle.com
```

Inline checkout renders in an iframe Paddle serves, which is what `frame-src` is for. If you run `hosted` mode you need none of this — the buyer leaves your origin entirely.

## 11. Discounts

Both halves work. Applying a code needs nothing but `discount.read`, so codes you mint by hand in the dashboard are fully served.

`POST /payments/checkout` takes an optional `discountCode`. The server resolves it — `GET /discounts?code=…&status=active` — and passes the resulting `dsc_…` to Paddle unchanged. **Pithy never computes a discounted amount.** Paddle is the authority on what is owed, and a second calculation here would be a second answer to the one question a customer checks against their statement. An unresolvable code is `payments/discount_invalid` naming the code, distinctly from a payment failure — one refusal for "no such code", "expired" and "limit reached" alike, because naming which would tell an unauthenticated enumerator which codes exist.

Minting goes through `POST /payments/admin/discounts` behind `payments:discounts:create`, or `pithy payments discount create`.

Two things Paddle does differently:

- **Its codes are `^[a-zA-Z0-9]{1,32}$`.** No dashes, no underscores. `DiscountCode` in this package is deliberately wider — narrowing it would refuse codes the Stripe and Lemon Squeezy rails accept today — so the Paddle rail refuses a code it cannot mint, and says which characters. Paddle's own refusal is the string `"Invalid request."` with no field named.
- **`maximum_recurring_intervals` counts billing periods**, which is the unit `duration: { kind: "repeating", billingPeriods }` already uses. So the number passes through unconverted. Stripe's `duration_in_months` counts months, and that is where the translation happens. On an annual plan the difference is a year versus twelve years.

`redeemableUntil` maps to `expires_at`, which stops **redemption**: after it the code cannot be claimed, and anyone already holding the discount keeps their rate for its full duration.

## 12. The customer portal

`POST /payments/portal` takes **no body at all**. There is exactly one Paddle customer this caller may manage, resolved from the provider-account map, and the subscriptions asked about are read from that caller's own rows. A field naming either would let any signed-in caller mint authenticated cancel links against somebody else's subscription.

The response carries the overview page plus, per subscription, a cancel link and an update-payment-method link.

**Treat every one of those URLs as a bearer credential for that customer's billing.** Paddle's overview link carries a `pga_` token whose lifetime is **24 hours**, with scopes covering `customer.subscription.update`, `customer.customer.update` and `customer.transaction.create`. Never cache one, never persist one, never log one, and never put one anywhere a `Referer` header would carry it onward.

There is **no `portalReturnUrl`**. Paddle's portal takes no return parameter, so `paddle.portalReturnUrl` is refused by config rather than accepted and dropped — a return URL you wrote that nothing reads is a lie in a file you trust.

## 13. Reconciliation, and the sweep only this rail can do

`pithy payments reconcile --rail paddle` runs the nightly pass on demand. It does two things.

**`refresh`** re-reads a purchase this deployment already holds — `GET /subscriptions/{id}` for a subscription, `GET /transactions/{id}` for a transaction.

**The events sweep** finds what `refresh` cannot. A purchase whose webhook was never delivered and which no client submitted has no row, so `refresh` is blind to it forever. Paddle publishes an account-wide event stream, so the sweep walks it — `GET /events?order_by=id[ASC]&after=<cursor>`, filtered to exactly the event types above, and projected through the same map a webhook uses. The cursor lives in `pithy_payments_sync_cursors` and advances only past events fully projected: the first failure halts it, and the step retries next run.

**Paddle retains 90 days of events.** A cursor older than that can never be caught up, so the sweep reports a gap naming the window rather than silently restarting from the beginning and re-projecting three months.

## What lands where

| Event | Projects |
|---|---|
| `transaction.created`, `transaction.ready` | nothing. No money has moved. |
| `transaction.paid`, `transaction.completed` | a **one-off** goes `active` and never expires. A **subscription's** transaction goes `expired` — one closed, paid billing period. It credits a `grants` clause and grants no access, because access is the subscription row's job. |
| `transaction.payment_failed`, `transaction.past_due` | `in_grace`. Credits nothing. |
| `transaction.canceled` | `never_paid`. Terminated before anything cleared. |
| `transaction.billed` | `on_hold`. Manual collection, which this rail does not sell through. |
| `transaction.updated`, `transaction.revised` | re-derived from `status`. |
| `subscription.created`, `.activated`, `.resumed`, `.updated`, `.imported` | derived from `status`. |
| `subscription.trialing` | `active`, expiring at the trial's end. A trial is access the store is giving, and the date on the row is what bounds it. |
| `subscription.past_due` | `in_grace`. |
| `subscription.paused` | `paused`. |
| `subscription.canceled` | `canceled`, expiring at the current period's end. Paid time already bought is not taken away. |
| `adjustment.*`, `action: refund` or `chargeback`, `status: approved`, covering the full total | `refunded`, and the subscription is revoked with it. |
| the same, covering less | nothing. A partial refund is recorded with a note and the entitlement stands. |
| `action: chargeback_reverse`, approved | back to what the transaction says, on a later clock. |
| `action: credit`, `credit_reverse`, `chargeback_warning`, `chargeback_warning_reverse` | nothing. A credit is not a revocation and a warning is not a decision. |
| any adjustment `pending_approval`, `rejected`, `reversed` | nothing. |
| everything else | recorded, projects nothing, 200. |

A subscription writes **two rows**: a `state` row keyed on `sub_…` that carries access, and a `charge` row per `txn_…` that carries the money. That is why two renewals credit a `grants` clause exactly twice, and why a cancellation stops access without rewriting any receipt.

**A refund can arrive with nothing preceding it.** Paddle is merchant of record and issues refunds on its own account — for a chargeback, a tax dispute, or its own support decision. Every other rail here but Lemon Squeezy only ever sees refunds it initiated.

## Testing

The [sandbox](https://sandbox-vendors.paddle.com) is a separate account with its own everything. Paddle's webhook simulator sends a real signed delivery to a URL you give it, which is the way to exercise the guard without a purchase.

`4242 4242 4242 4242` with any future expiry and any CVC completes a sandbox checkout.
