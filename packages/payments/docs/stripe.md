# Stripe

Wiring Stripe into `@pithy-sh/payments`. Step by step.

Stripe is the web rail, and it is **hosted only**. Stripe presents the payment page, handles the card, and owns SCA, tax, and receipts; Pithy sends a browser there and hears the outcome on a webhook. There is no Payment Element, no card fields in your app, and no plan-change or proration logic. That is a decision rather than a stage — those surfaces change with regulation, and they belong to the company whose job it is to keep up with it.

## Why this part is manual

Everything below is created in the [Stripe Dashboard](https://dashboard.stripe.com) by a human with access to your Stripe account. Pithy cannot provision it for you: prices are commercial decisions, a webhook endpoint's signing secret is shown once, and the Billing Portal's configuration is a set of choices about what your subscribers may do. One-time setup per environment. Everything after it is config.

## 1. Create your products and prices

Under **Product catalogue**, create a product and give it a price. Recurring for a subscription, one-off for anything else.

The **price id** — `price_1Abc…`, not the product id — is what goes in `pithy.config.ts`.

```ts
payments({
  rails: { stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      stripe: { priceId: "price_1Abc" },
    },
  },
});
```

The catalog is the only place a price id appears. Gating code names `pro`.

A price id is **publishable** by design — it is what a Checkout Session names, so it may reach a browser. The secret key and the webhook signing secret never do; they live in the secrets store.

Test mode and live mode have different price ids. So do your staging and production configs.

## 2. Declare the return URLs

`stripe.successUrl`, `stripe.cancelUrl`, and `stripe.portalReturnUrl` are **required whenever the rail is on**, and a project that turns Stripe on without them fails to parse its config at deploy. That is deliberate: the alternative is a build that ships, sells nothing, and reports it as a 404 on somebody's first checkout.

They are config rather than request input, and that is the security part. A client that could name where hosted Checkout returns to could send a paying customer to a page it controls.

Put `{CHECKOUT_SESSION_ID}` somewhere in `successUrl`'s query. Stripe substitutes the real session id when it redirects, and your thank-you page can post it straight to `POST /payments/purchases`:

```ts
await fetch("/payments/purchases", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ rail: "stripe", receipt: new URLSearchParams(location.search).get("session") }),
});
```

Nothing about correctness rests on that call — the webhook produces the identical row through the same idempotent writer. What it buys is the buyer seeing their entitlement on the thank-you page instead of a second or two later.

## 3. Create the webhook endpoint

Under **Developers** → **Webhooks**, add an endpoint pointing at `https://<your-worker>/payments/webhooks/stripe`, one per environment.

Subscribe it to these events, and only these:

| Event | What it does |
|---|---|
| `checkout.session.completed` | Binds the Stripe customer to a Pithy user, and projects a one-time purchase |
| `checkout.session.async_payment_succeeded` | A delayed payment method (bank debit, voucher) finally cleared |
| `checkout.session.async_payment_failed` | It did not |
| `customer.subscription.created` | A subscription began |
| `customer.subscription.updated` | It renewed, lapsed into retry, was paused, or had auto-renew turned off |
| `customer.subscription.deleted` | It ended |
| `charge.refunded` | A one-time purchase was refunded |

Anything else is recorded and ignored, so subscribing to more costs you table rows and nothing else. Subscribing to fewer loses purchases.

Stripe shows the endpoint's **signing secret** — `whsec_…` — once. That is what verifies every delivery.

## 4. Configure the Billing Portal

Under **Settings** → **Billing** → **Customer portal**, configure and save it. Choose what a subscriber may do there: cancel, switch plan, update a card, download invoices.

Until you do, `POST /payments/portal` answers 404 with Stripe's own explanation in the log. That is the failure every adopter hits exactly once.

Those choices live in Stripe rather than in `pithy.config.ts` on purpose. Plan changes and proration are Stripe's to get right, and a Pithy setting that decided any of them would be Pithy owning them.

## 5. Get the two credentials

The **secret key** — `sk_live_…` or `sk_test_…` — from **Developers** → **API keys**. It creates hosted sessions and retrieves them.

The **webhook signing secret** — `whsec_…` — from the endpoint you created in step 3.

Use a **restricted key** if you would rather: hosted checkout needs write on Checkout Sessions and Billing Portal sessions, and read on Checkout Sessions. Nothing else.

## Where the credentials live

**Both values travel as one typed JSON secret**, through `@pithy-sh/secrets` — never committed, never an env literal. Stripe's block sits inside `payments-provider-credentials` alongside any other rail's:

```sh
echo '{"stripe":{"secretKey":"sk_live_…","webhookSecret":"whsec_…"}}' \
  | pithy secrets create payments-provider-credentials --env production
```

The value comes from stdin, or from a prompt at a terminal. The secret is environment-scoped, so `--env` is required and each environment holds its own — which is what keeps a test-mode key and a live one apart.

A rail's block is present in full or absent entirely, and that is enforced where you can see it: the registry's schema is checked before the write lands, so half a credential is a refusal in your terminal rather than a signature check that silently never passes.

The secret is **rotatable**, per environment. Stripe lists a signature per active secret while an endpoint's secret is being rolled, and payments accepts a delivery whose second signature matches — so a rotation drops nothing.

## What a Stripe purchase actually does

Worth knowing, because it explains the failure modes:

1. Your paywall posts to `POST /payments/checkout` with a catalog product id. The **price** comes from the catalog, the **return URLs** from config, and the **purchaser** from the authenticated session — none of them from the request body.
2. Payments creates a Checkout Session with `client_reference_id` set to the purchaser, and sends the browser to Stripe's page.
3. Stripe takes the money and POSTs `checkout.session.completed`. Its `client_reference_id` and its `cus_…` are what write the `(stripe, cus_…) → user` row. **This is the only place that link is ever made**, because a Stripe purchase is only ever heard about through a webhook.
4. The subscription's own events carry the state. Each one is verified — HMAC over the exact bytes, inside a five-minute window — then recorded, then projected.
5. Every delivery lands in `pithy_payments_webhook_events`, with `processedAt` and any reason it was not projected.

So: a delivery that fails its signature is 401 and **nothing is recorded**, which is what stops a forger filling the table. A delivery Stripe signed but this build does not act on is 200 with a row. A test-mode purchase against a production deployment is 200, is not projected, and records `payments/environment_mismatch`.

**Identifiers, since they surface in your data.** A subscription purchase is keyed on the **invoice** id, so each billing period is its own row — which is what makes a `grants` clause credit once per period rather than once ever — and the subscription id is the family key that ties renewals to the buyer. A one-time purchase is keyed on the **payment intent**, because a later refund names the payment intent and nothing else.

**One bounded gap.** A session Pithy did not create — a Payment Link built in the dashboard — carries no price this code can resolve, since a Checkout Session's line items are not in its webhook payload. The delivery is recorded with the payment intent in its `error` column and the reconciliation pass repairs it. Sell through `POST /payments/checkout` and it never arises.

## Testing without spending money

Use a test-mode key and a test-mode webhook endpoint. Every object Stripe makes with a test key carries `livemode: false`, and payments treats every one of them as **sandbox** — a test purchase reaching a production deployment is refused with `payments/environment_mismatch` and grants nothing. That is deliberate and it is the single most common in-app-purchase defect there is.

`stripe listen --forward-to localhost:8787/payments/webhooks/stripe` gives you a local endpoint and its own `whsec_…`. Put that one in your local `payments-provider-credentials` — the CLI prints a different secret from the dashboard's, and using the dashboard's against a forwarded delivery is a signature failure that looks like a bug.

Point a staging deployment at test mode with its own endpoint and its own secret, and test purchases project there.

## What Pithy deliberately does not do

No Payment Element or card fields. No proration, plan-change, or upgrade logic. No tax configuration. No invoice or receipt rendering. No Stripe Connect.

All of it is Stripe's, reachable from the dashboard and the Billing Portal, and none of it is a small edit away in this package. If you need a plan switch, put it in the portal's configuration.

## Checklist

- [ ] Products and prices created; price ids in `pithy.config.ts` under each product's `stripe` block.
- [ ] `stripe.successUrl`, `cancelUrl`, and `portalReturnUrl` declared, with `{CHECKOUT_SESSION_ID}` in the success URL's query.
- [ ] Webhook endpoint created per environment, pointing at `/payments/webhooks/stripe`.
- [ ] Subscribed to the seven events in step 3 — no fewer.
- [ ] Signing secret copied at creation; it is shown once.
- [ ] Customer portal configured and saved, per environment.
- [ ] `secretKey` + `webhookSecret` stored together via `pithy secrets create payments-provider-credentials`; `rails: { stripe: true }` in config.
- [ ] Thank-you page posts the session id to `/payments/purchases`, so a buyer sees their entitlement at once.
- [ ] Test-mode endpoint and key for staging, with their own secret.
