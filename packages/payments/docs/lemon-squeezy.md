# Lemon Squeezy

Wiring Lemon Squeezy into `@pithy-sh/payments`. Step by step.

Lemon Squeezy is the **merchant of record**, and that is the entire reason to choose it over Stripe. It owns the tax registration, the EU VAT, the invoice, the dunning and the chargebacks — it sells to your buyer and pays you, rather than processing a payment on your behalf. Like Stripe here, it is **hosted only**: Lemon Squeezy presents the payment page and takes the card, Pithy sends a browser there and hears the outcome on a webhook. No card fields in your app, no plan-change or proration logic, and no tax settings of ours to get wrong.

## Why this part is manual

Everything below is created in the [Lemon Squeezy dashboard](https://app.lemonsqueezy.com) by a human with access to your store. Pithy cannot provision it for you: prices are commercial decisions, and a webhook signing secret is chosen once and shared with exactly one deployment. One-time setup per environment. Everything after it is config.

## 1. Create your store, products and variants

You need a store before anything else — Lemon Squeezy sells on your behalf, so the store is the legal party doing the selling and it is what your credentials name.

Under **Products**, create a product and give it a **variant**. A variant is Lemon Squeezy's price-equivalent: it carries the amount, the interval, and the trial. So the **variant id** — `123456`, not the product id — is what goes in `pithy.config.ts`, exactly where Stripe's `priceId` sits.

```ts
payments({
  rails: { lemonSqueezy: true },
  lemonSqueezy: {
    successUrl: `${PUBLIC_ORIGIN}/thanks`,
  },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      lemonSqueezy: { variantId: "123456" },
    },
  },
});
```

The catalog is the only place a variant id appears. Gating code names `pro`.

A variant id is **publishable** by design — it is what a hosted checkout names, so it may reach a browser. The API key and the webhook signing secret never do; they live in the secrets store.

Test mode and live mode hold different products, and so different variant ids. So do your staging and production configs.

## 2. Declare the return URLs

`lemonSqueezy.successUrl` is **required whenever the rail is on**, and a project that turns Lemon Squeezy on without it fails to parse its config at deploy. That is deliberate: the alternative is a build that ships, sells nothing, and reports it as a 404 on somebody's first checkout.

They are config rather than request input, and that is the security part. A client that could name where hosted checkout returns to could send a paying customer to a page it controls. Build both on `PUBLIC_ORIGIN` and never on a literal — an origin written down is production's origin written into staging.

`successUrl` is what the created checkout carries as its `redirect_url`. It is the only one, where Stripe takes three, and both absences are the store's rather than an omission in Pithy: Lemon Squeezy's checkout has no cancel destination — a buyer who backs out closes the tab — and its customer portal is a signed, expiring link with nowhere to return to.

There is **no `portalReturnUrl`**, and there is nowhere for one to go. Stripe mints a Billing Portal session per caller and takes a return URL with it; Lemon Squeezy's customer portal is a signed, expiring link hanging off the customer object, which `POST /payments/portal` reads back and hands over. The link takes no return parameter — the subscriber closes the tab — so this rail declines one in the type rather than accepting a URL it would silently drop.

**Your success page must show a pending state and wait for the webhook. It cannot post a receipt, because this rail has no receipt to post.** `POST /payments/purchases` refuses a Lemon Squeezy submission with `payments/invalid_receipt`, and that refusal is the secure answer rather than a gap.

Stripe can confirm on return because the buyer comes back holding a Checkout Session id Stripe substituted into the URL: an unguessable token your own server trades for a session carrying the reference it set. Lemon Squeezy has no equivalent. Its order ids are **sequential integers**, so a `verify` that trusted a submitted order id would let any authenticated caller claim any order in the store by counting — including one belonging to somebody who has not signed in yet, whose purchase would then be bound to the attacker forever, since the first pairing wins and nothing rebinds it.

The order's UUID `identifier` looks like the repair and is not one. It is unguessable, but it is not a *credential*: it appears in the buyer's own receipt email and in the storefront's return URL, so it proves possession of a value that was never secret, and the order object carries no reference this server set that could be checked against the caller. Binding on an unguessable-but-unauthenticated identifier is what lets a client's choice of value decide who a purchase belongs to.

What it costs, stated plainly: a Lemon Squeezy buyer's entitlement appears when the webhook lands rather than the moment they return — seconds, usually. Show pending, poll `GET /payments/entitlements`, and render the entitlement when it arrives. The webhook is authoritative on every rail anyway; here it is the only path.

## 3. Create the webhook endpoint

Under **Settings** → **Webhooks**, add an endpoint pointing at `https://<your-worker>/payments/webhooks/lemon-squeezy`, one per environment. If you moved `basePath`, register the URL to match.

You choose the **signing secret** yourself when you create the webhook. That is what verifies every delivery: a bare HMAC-SHA256 over the exact received bytes, in `X-Signature`.

Subscribe it to these events, and only these:

| Event | What it does |
|---|---|
| `subscription_created` | A subscription began — writes the `state` row that carries access |
| `subscription_updated` | It renewed, lapsed into dunning, or had its status moved otherwise |
| `subscription_cancelled` | Auto-renew was turned off; access runs to the date the row now carries |
| `subscription_expired` | It ended |
| `subscription_paused` | The subscriber suspended it; `paused` grants nothing |
| `subscription_unpaused` | They resumed it |
| `subscription_payment_success` | One billing period was paid — writes the `charge` row that credits a `grants` clause |
| `subscription_payment_failed` | An invoice was not paid; the charge row records it and credits nothing |
| `subscription_payment_recovered` | A failed invoice was collected after all |
| `subscription_payment_refunded` | The invoice was refunded, and access is revoked with it |
| `order_created` | A one-off purchase — money and state in one row |
| `order_refunded` | It was refunded |

Anything else is recorded and ignored, so subscribing to more costs you table rows and nothing else. Subscribing to fewer loses purchases.

## 4. Get the three credentials

The **API key** from **Settings** → **API**. It creates hosted checkouts, reads orders and subscriptions, and mints customer-portal links.

The **webhook signing secret** — the one you chose in step 3.

The **store id** from your store's settings. It is the store this deployment sells through, and the checkout call names it.

The API key is **account-wide**: it returns test-mode objects to a production deployment too. That is why `test_mode` on the object — never the key — decides a purchase's environment, which is the opposite of Stripe's arrangement and the thing to know before reading the next section but one.

## Where the credentials live

**All three values travel as one typed JSON secret**, through `@pithy-sh/secrets` — never committed, never an env literal. Lemon Squeezy's block sits inside `payments-provider-credentials` alongside any other rail's:

```sh
echo '{"lemonSqueezy":{"apiKey":"…","webhookSecret":"…","storeId":"12345"}}' \
  | pithy secrets create payments-provider-credentials --env prod
```

The value comes from stdin, or from a prompt at a terminal. The secret is environment-scoped, so `--env` is required and each environment holds its own — which is what keeps a staging store's signing secret and production's apart.

A rail's block is present in full or absent entirely, and that is enforced where you can see it: the registry's schema is checked before the write lands, so half a credential is a refusal in your terminal rather than a signature check that silently never passes.

The secret is **rotatable**, per environment, but a Lemon Squeezy rotation is a cutover rather than an overlap. Its scheme sends one signature and this rail checks the one secret stored for the environment, so change the webhook's secret and the stored value in the same sitting. Deliveries signed with the old secret are refused 401 in between, and Lemon Squeezy redelivers them.

## What a Lemon Squeezy purchase actually does

Worth knowing, because it explains the failure modes:

1. Your paywall posts to `POST /payments/checkout` with a catalog product id. The **variant** comes from the catalog, the **return URL** from config, and the **subject** — the person or the organization this purchase will belong to — from the subject seam, which resolves it from the authenticated session. None of the three comes from the request body.
2. Payments creates a hosted checkout with that subject stamped into `checkout_data.custom` as `pithy_account_reference` — one string, `user:<id>` or `organization:<id>`, because either half of the pair alone is ambiguous — and this deployment's environment beside it as `pithy_env`. Both keys are snake_case because Lemon Squeezy normalizes them before echoing them back. The browser goes to the URL Lemon Squeezy returns.
3. Lemon Squeezy takes the money as merchant of record and POSTs its webhook. The echoed `pithy_account_reference` and the delivery's `customer_id` are what write the `(lemonSqueezy, <customer id>) → subject` row. **This is the only place that link is ever made**, because this rail has no client-submission path at all. A reference that is not exactly that encoding decodes to nobody — a bare id, the format that predates subjects, is refused rather than read as a user — and the delivery lands unbound.
4. Every delivery's `X-Signature` is verified — an HMAC over the exact received bytes — then recorded, then projected. There is no timestamp in the scheme and so **no freshness window**: replay protection is entirely the `UNIQUE (rail, providerEventId)` insert, with the projection's monotonic `providerEventAt` rule behind it.
5. An invoice-domain delivery costs one read. A subscription invoice carries no variant, and the writer needs one, so the rail reads the invoice's subscription to learn which variant it bills. Subscription and order deliveries carry everything they need and cost nothing.
6. Every delivery lands in `pithy_payments_webhook_events`. A delivery that projected carries `processedAt`; one that did not carries the reason and no `processedAt`, so the store's next attempt — or your replay — runs it again.

So: a delivery that fails its signature is 401 and **nothing is recorded**, which is what stops a forger filling the table. A delivery Lemon Squeezy signed but this build does not map — a license-key event, an affiliate payout — is 200 with a row and nothing else. A test-mode purchase against a production deployment is 200, is not projected, and records `payments/environment_mismatch`. An outage at Lemon Squeezy while an invoice delivery is being read answers `payments/provider_unavailable` (503) rather than a signature failure, so the store redelivers instead of an operator hunting for a rotated key.

**Identifiers, since they surface in your data.** Lemon Squeezy numbers **each object type from one** and renders the number as a string, so order `8801` and subscription-invoice `8801` are different objects wearing the same id. A purchase row's identity is `UNIQUE (rail, providerTransactionId)`, so storing the bare id would fuse an order and an invoice into one row — one buyer's refund landing on another buyer's subscription. This rail therefore namespaces every id by the object type it came from: `subscription:90001`, `subscription_invoice:8001`, `order:7001`. Stripe never faced this, because `pi_`, `in_` and `sub_` are globally distinct. The prefix is part of the row's identity forever.

A subscription also produces **two kinds of row**, which no other rail does. One `role = 'state'` row keyed `subscription:<id>` carries the standing — active, paused, canceled — and is what grants access. One `role = 'charge'` row keyed `subscription_invoice:<id>` per billing period carries the money, and names the subscription as its family. **Only `charge` rows fulfill a `grants` clause**, so N renewals credit exactly N times. This is not a modeling preference: Lemon Squeezy splits money from state at the source. `subscription_payment_*` delivers an amount and nothing about whether the subscription is still live, `subscription_*` delivers a status and no charge, and its subscription object carries no latest-invoice pointer, so neither names the other's key. Collapsing them would stamp two different clocks into one monotonic watermark and drop the renewal that follows a refund.

**One bounded gap.** A purchase made in the Lemon Squeezy storefront rather than through `POST /payments/checkout` carries no stamp of yours, so nothing Pithy trusts says which subject it belongs to. If that customer has bought through your checkout before, the provider-account map already knows them and the purchase projects onto that subject. If they have not, the delivery is recorded as orphaned with an audit warning and projects nothing — there is no subject to project it onto, and no number of retries conjures one. Sell through `POST /payments/checkout` and it never arises.

## Sharing one store across environments

A Lemon Squeezy store is **one namespace across every environment**. Test mode is a flag on an object, not a separate store, so a `dev` deployment and a `staging` deployment pointed at one store both hear everything the other's buyers do.

Pithy stamps this deployment's `ENVIRONMENT` into `checkout_data.custom` as `pithy_env` when it creates the checkout, and reads it back off `meta.custom_data` on every delivery. An event stamped for another deployment projects nothing: no row, no entitlement, no audit warning, and a 200. The other deployment, which is the one that started that checkout, projects it.

Two things are deliberately outside the fence. A delivery carrying **no** stamp is not fenced out — a storefront order was still a real sale, and fencing on absence would drop it silently. And a deployment that does not know its own `ENVIRONMENT` fences nothing, which is how the other three rails behave too.

**An unstamped delivery is projected but never trusted to say who it belongs to**, and that distinction is load-bearing. Lemon Squeezy's public buy links accept `checkout[custom][...]` parameters, and the webhook echoes them exactly as one of yours would — so `custom_data` alone is not evidence your server wrote anything. A stranger could otherwise put any reference in it and bind their store customer to it permanently, since the provider-account map never rebinds — and under organization billing the reference to aim at is guessable from a company id they may already know. Pithy therefore honors `pithy_account_reference` only when its own environment stamp is beside it, and it compares both halves of the pair it decodes to, never the id alone. A storefront purchase by a customer your checkout already knows still lands on their account, through the account map; one by a stranger lands unbound and is repairable from the trail.

`test_mode` is a separate axis. It drives the purchase's `environment`, and the projection writer refuses across that one outright.

## Testing without spending money

Turn on test mode in the dashboard and buy through the test-mode variant. Every object Lemon Squeezy makes there carries `test_mode: true`, and payments treats it as **sandbox** — a test purchase reaching a production deployment is refused with `payments/environment_mismatch` and grants nothing. That is deliberate and it is the single most common in-app-purchase defect there is.

An object that does not say which mode it is in lands on sandbox as well. The failure directions are not symmetric: treating production as sandbox loses a purchase that reconciliation repairs, while treating sandbox as production hands out real entitlements for test money.

Note that the account-wide API key is not part of this decision. There is no test key to hold apart from a live one, so the object's own flag is the only signal — which is why a staging deployment and a production one can share a key and must not share a stamp.

There is no local forwarder for this rail. Lemon Squeezy POSTs to a URL it can reach, so point a staging deployment with its own webhook and its own signing secret at test mode, and test purchases project there.

## What Pithy deliberately does not do

No card fields, and no embedded checkout. No proration, plan-change, or upgrade logic. No tax configuration — that is the merchant of record's job, and it is the reason you chose this rail. No license keys: their events are recorded and ignored, and nothing in this package issues or validates one. No affiliates, no discount codes, and no quantity — the variant *is* the price, and a checkout that could name an amount would be a checkout a client could name an amount on.

All of it is Lemon Squeezy's, reachable from its dashboard and its customer portal, and none of it is a small edit away in this package.

## Checklist

- [ ] Store created, and its id copied.
- [ ] Products and variants created; variant ids in `pithy.config.ts` under each product's `lemonSqueezy` block.
- [ ] `lemonSqueezy.successUrl` declared, built on `PUBLIC_ORIGIN`.
- [ ] Success page shows a pending state and polls — it posts no receipt, because there is none.
- [ ] Webhook endpoint created per environment, pointing at `/payments/webhooks/lemon-squeezy`.
- [ ] Subscribed to the twelve events in step 3 — no fewer.
- [ ] Signing secret chosen at creation and stored for that environment alone.
- [ ] `apiKey` + `webhookSecret` + `storeId` stored together via `pithy secrets create payments-provider-credentials`; `rails: { lemonSqueezy: true }` in config.
- [ ] Test-mode variants bought against a staging deployment with its own webhook and secret.
