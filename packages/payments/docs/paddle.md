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
| `adjustment.read` | telling a full refund from a partial one |

**`customer_portal_session.write` is the one to check twice.** Without it Paddle returns a portal session with no authenticated URLs and your subscriber lands on a sign-in page instead of their billing.

**`adjustment.read` is required, and only for refunds.** An adjustment says how much came off and never what the original was, so the only way to tell a full refund from a partial one is to read the transaction with `include=adjustments` and sum them. Paddle's permissions reference is explicit that an `include` demands read permission on the entity included, and answers `forbidden` (403) without it — so a key missing this does not quietly return a shorter response, it refuses the read. Only the refund path asks for that include: checkout, verification and reconciliation read a transaction without it and work on `transaction.read` alone. A refusal from the refund path names `adjustment.read` in its detail, so you are not left guessing which of the permissions above is missing.

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
  "pithy_user": "user:<id>",
  "pithy_env": "<this deployment's ENVIRONMENT>",
  "pithy_ref_proof": "<HMAC-SHA256 over (env, reference), keyed with the webhook secret>"
}
```

**The first key says `user` and its value is no longer always one.** What travels there is the subject this purchase belongs to, encoded as one string — `user:<id>` under `billingSubject: "user"`, `organization:<id>` under `"organization"`. The key name is frozen on purpose: it is a wire contract with Paddle, not an identifier of ours. A checkout stamped today is a transaction open in somebody's browser and a `custom_data` object Paddle stores verbatim for the life of the customer, so renaming the key would make every in-flight purchase come back naming nobody, permanently. The name stayed; the meaning moved.

The third is the only one that means anything, and here is why. `custom_data` is **client-writable**, on both forms of `Paddle.Checkout.open`, needing nothing but the publishable client token — the token this rail ships to every browser that loads your paywall. Both of these were driven against the live sandbox and paid with a test card:

- `Paddle.Checkout.open({ items: [{ priceId, quantity }], customData: {…} })` completes with no server involved at any point, and Paddle stores the page's object verbatim.
- `Paddle.Checkout.open({ transactionId, customData: {…} })` **replaces** the `custom_data` your server wrote when it created that transaction. Same id, `origin` still `api`, holder now whoever the page said. It is not refused and it does not throw.

The overwrite lands when the checkout is **opened**, not when it is paid: a transaction left in `draft` had its `custom_data` replaced by a checkout nobody completed. So a stranger can write `pithy_user` and `pithy_env` — the key names are exported constants in an open-source package, the environment is one of three values, and under organization billing the reference is guessable from a company id the attacker may already know — and creating the transaction server-side does not protect them.

What they cannot write is a MAC keyed on your notification destination's secret. So the rail honours a stamped reference only when the proof verifies, and refuses it otherwise. A delivery with no stamp at all — a transaction you created by hand in the dashboard — is not fenced out; it simply binds nobody.

## 9. The dev-to-staging caveat

`dev` is not publicly routable, so a dev checkout's webhooks land at **staging**. Both point at one Paddle sandbox, and a sandbox has exactly one set of notification destinations. **A delivery stamped for another environment is the normal case on this rail, not an anomaly.**

Each instance checks every delivery against its own `ENVIRONMENT`. One stamped for somebody else is authentic, is recorded in `pithy_payments_webhook_events`, projects nothing, grants nothing, **emits no audit warning**, and returns 200. No warning deliberately: on a shared sandbox it would fire on most deliveries and train you to ignore the channel.

So a dev purchase reaches your database through `verify` rather than through a webhook. The overlay's `checkout.completed` callback hands the browser a `txn_…`; your screen posts it to `POST /payments/purchases`; the rail reads the transaction and binds it — refusing when the transaction's own proven `custom_data.pithy_user` names a subject other than **the one the caller is acting for**. That is the comparison, and it is not the caller's own user id: under organization billing every legitimate purchase is stamped `organization:<id>`, so checking it against the person who submitted it would refuse all of them. Both halves of the pair are compared, because nothing keeps an organization id from equalling some user's id. That is why `verify` exists on this rail where Lemon Squeezy refuses one: the id is a pointer, and the stamp is the authorization.

## 10. Paddle.js and your Content Security Policy

Paddle.js is a **remote script from Paddle's CDN**, and it is the first third-party script this kit has ever asked you to load. Your CSP has to allow it:

```
script-src  https://cdn.paddle.com
connect-src https://*.paddle.com
frame-src   https://*.paddle.com
img-src     https://*.paddle.com
```

Inline checkout renders in an iframe Paddle serves, which is what `frame-src` is for. If you run `hosted` mode you need none of this — the buyer leaves your origin entirely.

**The npm package does not change this.** `@pithy-sh/payments` loads Paddle.js through `@paddle/paddle-js`, and it is worth being exact about what that buys, because it is easy to assume it buys a CSP exemption. It does not. Read its source: `initializePaddle` creates a `<script src="https://cdn.paddle.com/paddle/v2/paddle.js">` and appends it to the document, exactly as a hand-written tag would. What the package gives you is a typed surface, one load per page whatever calls it, and a promise that resolves when the script is ready. `script-src https://cdn.paddle.com` is required either way.

## 11. Prices, read from Paddle for the visitor looking at them

`Paddle.PricePreview` is the only honest way to put a number on a pricing page, and the kit exposes it as `usePricePreview`:

```tsx
import { usePricePreview } from "@pithy-sh/payments/src/client/hooks";
import { priceSummary } from "@pithy-sh/payments/src/client/paddle";

const quoted = usePricePreview(paddleSetup, { items: [{ priceId, quantity: 1 }] });
```

`paddleSetup` is `paymentsConfig.paddle` — the client token and the environment, straight off the projection. It takes null, which is what the projection carries when the rail is off, so a screen never needs a conditional hook call.

Paddle.js initializes once per page, `Environment.set` runs with the environment you declared, and a **second call naming a different account is refused** rather than re-pointing an initialized Paddle at another one.

### What "localized" means here, measured

On a $5.00/month sandbox price with no `unit_price_overrides`, on 2026-08-13:

| Address | Subtotal | Tax | Total | Rate |
|---|---|---|---|---|
| US, 10001 (New York) | $5.00 | $0.44 | **$5.44** | 8.875% |
| US, 60602 (Chicago) | $5.00 | $0.75 | **$5.75** | 15% |
| US, 97201 (Portland, OR) | $5.00 | $0.00 | **$5.00** | 0% |
| US, no postal code | $5.00 | $0.00 | **$5.00** | 0% |
| GB, SW1A 1AA | $4.17 | $0.83 | **$5.00** | 20% |
| DE, 10115 | $4.20 | $0.80 | **$5.00** | 19% |
| JP, with `currencyCode: "JPY"` | ¥725 | ¥73 | **¥798** | 10% |

Three things follow, and each of them changes what you should build.

**Currency is not localized.** Every row but the last is in dollars, from a British and a German address alike. Currency comes from `unit_price_overrides` on the price — catalogue data, set per market in the dashboard. Without them, `PricePreview` gives you localized **tax and formatting**, which is real and worth having, and is not the same claim.

**The tax convention differs, and it is not a formatting detail.** The United States adds tax to the listed price: the seller receives $5.00 and the buyer pays $5.44. The EU, the UK and Japan take it out of an inclusive one: the buyer pays $5.00 and the seller receives $4.17. A single hardcoded string cannot mean "before tax" in Denver and "including VAT" in Berlin. That is what `priceSummary` is for — it returns the figure to show and the sentence that makes it true, and the two differ by country because the convention does.

**Within the United States, tax resolves at the postal code.** A country-only preview comes back at 0% and quotes $5.00 to a buyer whose card will be charged $5.44. `PricePreview` does not treat that as an error, so the kit does: a quote with no postal code sets `estimated: true` and the summary says *"Tax is settled at checkout."* rather than implying there is none. **Send a postal code where you have one.**

### Where the visitor's location comes from

Omit `address` and `customerId` and Paddle resolves the country from the browser's IP. That is right for a marketing page nobody has signed in to, and it is a guess everywhere else: **a customer is charged from their billing address**, because Paddle settles tax on the transaction's address rather than on where the browser connected from. In the United States the two differ by up to 15%.

So the kit resolves it in one place. `resolvePriceLocation` in `src/pricing/location.ts` takes what you know about a visitor, picks the best source available, and says which one it picked:

| `source` | From | Is it the charge? |
| --- | --- | --- |
| `customer` | a Paddle customer id. Paddle prices from the address it holds, which is the address the checkout charges | Yes. The only one that is not a guess |
| `address` | a billing address you hold and Paddle does not | Closer than the network, still not proof — the buyer may enter another |
| `ip` | nobody said | No. An estimate every time |

`priceQueryFor(items, location)` builds the request from it, and `quoteIsEstimated(location, taxUnresolved)` decides the label. `location.provisional` is true exactly when the source is `ip`. Every site that quotes goes through the resolver; three call sites deciding this for themselves is how a page quotes from an address the checkout does not charge from.

**Who Paddle prices a signed-in visitor as comes from your own Worker, not from the browser.** `GET /payments/pricing` answers `quotedFrom` — `{ "rail": "paddle", "providerAccountId": "ctm_…" }`, or `null` for a caller no store holds a customer for yet, or nothing at all on a Worker older than the bundle asking. It is read from the same provider-account row that `POST /payments/checkout` hands Paddle as `customer_id`, so the figure quoted and the figure charged resolve location from one row. `fetchPriceVisitor` makes the read and `usePriceVisitor` holds it; `ctm_…` is an identifier and authorizes nothing, and the route is `requireAuth()` and answers only about its own caller. The README's Routes section carries the response in full.

**An address-derived quote supersedes an IP-derived one**, and a screen renders both in turn on purpose. The pricing page paints before the session resolves, so the first figure is the IP estimate — labelled, because it is one — and the second is the price the card will be charged. A read that fails answers `null`, which quotes from the IP and says so: treating a failed request as proof there is no address on file is the unsafe direction, and it is the one that would print a final-looking figure that is wrong.

### In flight, and failed

Both states are specified, because both are on screen for someone.

**In flight**: `preview` is null and `loading` is true. The shipped screen holds the space with a line of text. A price that arrives a beat late is better than one that corrects itself in front of the buyer, and far better than a blank column.

**Failed**: `preview` is null, `failure` carries a renderable message, and **there is no fallback figure**. Falling back to a number written in a template reintroduces the whole defect — it is wrong in every country whose convention differs from the one it was written in, and it is wrong silently. The buy button still works; Paddle's own checkout quotes again on its own page.

**Overlapping**: only the latest quote is rendered, whichever answers first. Two previews can be in flight at once — an anonymous visitor's location resolves under the query, or a country picker moves — and without a guard the slower one wins by landing last, putting a price for an address the visitor has left on the screen whose whole job is showing a correct one. Superseded answers are *ignored*, not cancelled: `Paddle.PricePreview` takes no `AbortSignal` and returns a bare promise, so there is nothing to cancel. A superseded *refusal* is ignored the same way, which is what stops a dead request blanking a price already on screen.

### What the scaffolded screen does with `estimated`

It renders it. `priceSummary` returns `{ headline, note, estimated }`, and the screen puts *Estimated.* beside the figure when the flag is set — a quote short of tax must not look like a final one. The decision on record is **show what you know, label it, recalculate at the billing address**: an estimate that resolves at checkout is correct behaviour, and the label is what makes it honest rather than merely convenient.

### The anonymous visitor

The pricing screen is public — it declares no `session`, because a stranger has to be able to read a price and `PricePreview` needs nothing but the publishable token. `POST /payments/checkout` is `requireAuth()`, so the buy action is not public, and the screen says so **before** the click: an anonymous visitor gets one sentence and a named link to sign in, in place of a button that would refuse. Leaving it to the route guard sold someone a price and then redirected them away from what they were doing.

### Zero-decimal currencies

¥725 is `725`, not `72500`. Render `formattedTotals` and `formattedUnitTotals` — Paddle has already applied the currency's own decimal places, its symbol and its separators. Never format the raw amounts yourself; they are exposed for comparing, and a kit that formatted them would need a table of which currencies have decimals and would eventually get one wrong.

**The same rule reaches `GET /payments/pricing`.** `currentAmountMinor` and `listAmountMinor` are the store's integers in the smallest unit, so `500` is $5.00 in USD and ¥500 in JPY — the *number of decimals is a property of the currency*, and `/ 100` is a constant standing in for it. Read them beside `currency`, take the scale from the currency (`Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().minimumFractionDigits`), or pass a rendered total through untouched. A consumer that divides is right in every market it was tested in and wrong, silently, in Tokyo, Seoul and Santiago.

### A converted amount is not a stable number

The Japanese row above was fetched twice minutes apart and returned ¥797 then ¥798. Paddle's FX rate moves. Nothing should assert an exact converted figure against a live account, and a cached one is a figure nobody re-checked — which is why the cache below has no default lifetime and every caller states one.

### One quote path, shared

The marketing site and the dashboard quote the same plans from the same account, and each once carried its own copy of the twelve lines that do it. One copy was wrong for months — `#416` read `currencyCode` off the top of Paddle's answer when it lives under `data`, so the reader refused every real response and the screen rendered an empty price slot that looked deliberate. It was the *reviewed* copy that was wrong. Nothing could tell, because there was nothing both of them ran.

`quotePlans` is that thing:

```ts
import { quotePlans } from "@pithy-sh/payments/src/client/paddlePrices";

const quoted = await quotePlans(paddleSetup, { solo: soloPriceId, team: teamPriceId }, {
  query: { customerId },                                             // who to quote for
  cache: { key: "pricing", store: sessionStorage, ttlMs: 300_000 },  // where a quote may rest
});
```

It answers one `PaddlePlanQuote` per plan — `{ plan, priceId, headline, note, estimated, currency }` — off **one** `PricePreview` call, because Paddle answers a line per item and a page is one round trip. A plan Paddle returned no line for is left out rather than quoted from another plan's line, and a price two plans point at is asked for once.

**`query` is the location half of the request** — `customerId`, `address`, `customerIpAddress`, `currencyCode`, `discountId`, everything a `PricePreview` query carries except the prices themselves. Pass `customerId` for anyone signed in: a quote has to resolve from the same Paddle row the charge will, and without it a customer with an address on file is quoted from whatever network they are on and the figure comes back marked `estimated` because no postal code resolved. `resolvePriceLocation` above decides *which* of them you have; this is where it goes.

**`currency` is the currency Paddle answered in.** `headline` is already formatted, so a screen rendering it needs nothing else — a caller formatting the figure itself needs this, and it is the only place it exists.

### Caching a quote

Off unless you switch it on, and switching it on means saying three things:

| | |
|---|---|
| `key` | The namespace entries rest under. Two surfaces sharing a store share nothing else. |
| `store` | Where they rest. `localStorage`, `sessionStorage`, or anything with `getItem`/`setItem`/`removeItem`. |
| `ttlMs` | How long one may stand. |

**There is no default store and no default lifetime, and that is the whole design.** A quote resolved from `customerId` is one customer's price, resolved from the address on their account — `sessionStorage` and `localStorage` are the same interface and very different promises about a shared machine, and only the program that knows who is signed in can choose between them. **Signed in, reach for `sessionStorage`**, as the snippet above does: it is gone when the tab closes, which is the promise you want for a named customer's resolved address on a machine somebody else also uses. `localStorage` is right for the anonymous marketing page, where the quote belongs to nobody and outliving a tab is the point. Paddle's figures move, too: the FX rate above shifted between two calls minutes apart. A cached figure is a figure nobody re-checked, so how long that may last is yours to state rather than yours to inherit.

**A write clears the cache's own expired entries as it passes.** Nothing reads a departed customer's key again, so without a sweep nothing would ever expire it — a dashboard caching per customer on a shared machine accumulates one permanent entry per person who ever signs in, the origin's quota fills, and every write from then on fails silently. The sweep is scoped to that cache's own namespace and judged by its own `ttlMs`, so two surfaces sharing a store with different lifetimes never expire each other's answers. It needs `length` and `key` — `Storage` has both, so `localStorage` and `sessionStorage` get it; a custom three-method store still caches, it just does not get tidied.

**All three, or none.** Two of the three is what a caller reaches for first, and silently ignoring it would look exactly like caching that works — so it warns to the console, names the parts that are missing, and quotes from the network. A broken cache never fails a quote.

**The question is inside the key**, so one visitor can never be handed another's answer, and a sandbox answer cannot survive a deploy into production. A cached answer is read back through the same reader a fresh one is, so an entry an older bundle wrote is a miss rather than a price nobody validated. A store that throws — Safari in private browsing, a full quota — is a miss too, and costs the page one round trip rather than its prices.

A hit skips the Paddle.js load entirely, which is the part a visitor waits for.

### A site with no build step

A marketing page is not a React app. It has no bundler, no import map and often no `package.json`, and yet it is the page most people read a price on. So the same quote path ships as one classic script:

```html
<script src="/js/paddle-prices.js"
        data-paddle-env="sandbox"
        data-paddle-token="test_…"
        data-paddle-price-solo="pri_…"
        data-paddle-price-team="pri_…"></script>
```

The page names plans, never ids, and carries two slots per plan:

```html
<p data-price-plan="solo">Priced where you are billed</p>
<small data-price-note="solo"></small>
```

The script writes the formatted total into the first and **the sentence that makes it true into the second**. Both matter: in the United States the listed price is the subtotal and the buyer is charged more, so `$5.00` on its own is a number nobody pays — the note says *Plus $0.44 tax.* In Berlin the listed price already includes VAT and the note says so instead. A page that ships only the figure slot gets the figure and no sentence, which is the display §11 above exists to avoid; give every plan a note slot. Plan names are matched case-insensitively, because an attribute *name* is lower-cased by HTML and an attribute *value* is not.

A price id belongs to one Paddle account, so it is environment-specific and has no business in page content; whoever deploys the site puts the ids on the tag. `data-paddle-env` and the token's own prefix must agree — `sandbox` with `test_…`, `production` with `live_…` — and a tag pairing them the other way is refused rather than sent.

**The tag carries the location and the cache too**, because one artifact serves the marketing site and a signed-in dashboard both:

| Attribute | |
|---|---|
| `data-paddle-customer` | The `ctm_…` to quote as. Render it per visitor from your own Worker; omit it for a page nobody signs in to. |
| `data-paddle-cache` | The namespace to cache under. |
| `data-paddle-cache-store` | `local` or `session` — the two a browser has. A tag cannot hand over an object, so it names one. |
| `data-paddle-cache-ttl` | How long a quote may stand, **in seconds**. HTML counts a cache in seconds everywhere else. |

The three cache attributes go together or not at all; a tag naming some of them warns to the console and quotes from the network. A `data-paddle-customer` that is not a `ctm_…` is dropped rather than refused — the opposite call to the one a placeholder price id gets, and deliberately: a wrong price is unrecoverable, while a missing customer costs the visitor a quote resolved from their IP and labelled as the estimate it is, which is what every anonymous visitor already sees.

**Load it where you like.** The quote starts the moment the script runs and the paint waits for `DOMContentLoaded`, so a tag in `<head>` overlaps its round trip with parsing the page rather than racing it.

Build it with `bun run build` in `@pithy-sh/payments`; the artifact is `dist/paddle-prices.iife.js` and is published as `@pithy-sh/payments/paddle-prices.iife.js`, so a static site's deploy copies it out of `node_modules` into its own `/js/`. It bundles Paddle's own loader, so a page loads one file from this project and one from `cdn.paddle.com`, and nothing else.

**Everything the tag names carries the rail; the page's own slots do not.** `data-paddle-*` on the script, `data-price-plan` and `data-price-note` in the markup, `paddle-prices.iife.js` on disk, `window.pithyPaddlePrices` on the page. Which provider quotes is a deployment decision and belongs on the tag; a pricing page's slots are content, and naming a provider in them would mean rewriting the markup to change rails. It is also what leaves room for a second rail's quote script to arrive without renaming this one.

**It quotes nothing rather than quoting wrong.** A tag missing its environment or its token, or still carrying a `REPLACE_WITH_…` placeholder in any one of its ids, is refused before Paddle is loaded at all — no request, no console error, and every slot still holding the sentence the page shipped with. All or nothing across the plans, because a table with one real figure and one placeholder is the version a reader believes.

**Formatting stays with the page.** Set `data-paddle-paint="off"` and the script quotes without writing anything; `window.pithyPaddlePrices.quotes` resolves to the same `PaymentsResult` the module hands the dashboard, and the page does what it likes with it — a zero-fraction trim, its own markup, its own slots. Only the quote is shared, and it is shared because it is the part that was wrong in one of two copies for months while both looked fine.

## 12. Overlay and inline checkout

`paddle.checkout` in `pithy.config.ts` decides which of three the buyer sees, and the server puts the answer on the handoff so a screen never guesses:

| Mode | What happens |
|---|---|
| `overlay` | A modal over your page. The default, and no layout decisions. |
| `inline` | An iframe rendered into an element of yours. Looks like part of the app. |
| `hosted` | A redirect to Paddle's own page. Needs a default payment link on the account. |

`POST /payments/checkout` answers `{ kind: "paddle", transactionId, clientToken, environment, displayMode, successUrl }` in the first two, and the ordinary `{ kind: "redirect", url }` in the third. Nothing on that response is secret: the client token is publishable exactly as a Stripe price id is, and the API key and the signing secret are not expressible on it.

The screens are wired for you. `useCheckout().handoff` carries it, `usePaddleCheckout(handoff, { frameTarget })` opens it, and the scaffolded `paywall.tsx` and `pricing.tsx` render the container from `opened.inline` — so switching `overlay` to `inline` in your config needs no edit to a scaffolded file.

**Inline needs a container, and the container has to exist first.** `frameTarget` is a **class name**, not an id and not a selector. The open happens in an effect rather than in the click handler, because Paddle looks the element up at the instant it opens and React has to have committed the render that revealed it. Get that ordering wrong and Paddle throws `TypeError: Cannot read properties of undefined (reading 'appendChild')` out of your click handler — measured, not guessed. `openPaddleCheckout` checks for the element first and answers `client/paddle_no_container` instead, because a named refusal with an action beats somebody else's stack trace.

**One mount opens one checkout, including under `StrictMode`** — which is the mode `pithy ui add react` scaffolds: `client.tsx` wraps the router in it, so in development every effect runs, is cleaned up, and runs again. `usePaddleCheckout` remembers the transaction it opened rather than trusting that its effect runs once. It remembers the last id, not a flag: `start` mints a fresh transaction per attempt, so a buyer who closed the overlay and clicked Buy again arrives with a new one, and that one opens.

**Theme, locale and variant are yours to pass.** `usePaddleCheckout(handoff, { theme: "dark", locale: "fr", variant: "one-page" })` — and `openPaddleCheckout` takes the same three. Paddle's defaults are `light`, the browser's language, and `multi-page`.

| Option | |
|---|---|
| `theme` | `light` or `dark`. Pass the theme your app is currently in. |
| `locale` | `"fr"`, `"pt-BR"`. Pass it when your app has a language choice of its own. |
| `variant` | `one-page` or `multi-page`. |

**Omitted stays omitted.** A setting you do not pass is not sent — an absent key, never a key holding `undefined` — so it cannot override what your Paddle account is configured with. `{ theme: user.theme }` where the user has not chosen one is an absence, and arrives as one.

**Nothing infers your theme, deliberately.** Pithy does not read `prefers-color-scheme`, does not call `matchMedia`, and does not sample a computed style. The machine's preference is not your app's theme: an app with its own toggle, or one that is dark whatever the OS says, would get a card form contradicting the page it opened over — and a wrong guess is much harder to find than an option nobody passed. Your screen knows which theme it rendered. Tell it.

**Colours, fonts, borders and focus states are not settable from code at all, and that is Paddle's decision rather than a missing endpoint.** They are configured in the Paddle dashboard: **Checkout → Branded inline checkout** carries over 50 options for the inline frame, and the overlay takes a logo and a brand colour. Paddle's pitch for it is "no engineering resource needed", which is the same sentence read from the other side. There is one API that writes `primary_checkout_color` — `PATCH /settings/account`, documented under **Partners → Embed Billing** — and it is for a platform configuring *another* seller's account with a seller API key. Not a route for an adopter, and not one for Pithy. So `theme` is the whole of the styling this kit can pass, and there is no other API to go looking for.

The frame is styled `width: 100%; min-width: 312px; background-color: transparent; border: none;` at 450px by default. The `min-width` is Paddle's requirement rather than taste: below it the footer naming Paddle as merchant of record is cut off.

**The success path is a navigation.** `paddle.successUrl` is passed as `settings.successUrl`, so a buyer who pays leaves for your page in every mode — the same page the redirect rails return to, so your return screen is one screen. It travels on the handoff from config and never from the request, for the reason every return URL in this capability does: a client that could name one could send a paying customer to a page it controls.

**What the browser is allowed to open.** A transaction id, and settings. Never `items[]`, which would let the page choose what is being sold and to whom; never `customData`, which the server has already written. The type in `src/client/paddle.ts` cannot express either.

## 13. Testing checkout against a payment link in dev

The sandbox account's default payment link is normalised by Paddle to `https://`. `wrangler dev` serves plain HTTP on 8787, so a Paddle-generated **hosted** payment link will not connect in dev unless you run `pithy dev` with `--local-protocol=https`. Overlay and inline never route through that link and are unaffected.

## 14. Discounts

Both halves work. Applying a code needs nothing but `discount.read`, so codes you mint by hand in the dashboard are fully served.

`POST /payments/checkout` takes an optional `discountCode`. The server resolves it — `GET /discounts?code=…&status=active` — and passes the resulting `dsc_…` to Paddle unchanged. **Pithy never computes a discounted amount.** Paddle is the authority on what is owed, and a second calculation here would be a second answer to the one question a customer checks against their statement. An unresolvable code is `payments/discount_invalid` naming the code, distinctly from a payment failure — one refusal for "no such code", "expired" and "limit reached" alike, because naming which would tell an unauthenticated enumerator which codes exist.

Minting goes through `POST /payments/admin/discounts` behind `payments:discounts:create`, or `pithy payments discount create`.

Three things Paddle does differently:

- **Its codes are `^[a-zA-Z0-9]{1,32}$`.** No dashes, no underscores. `DiscountCode` in this package is deliberately wider — narrowing it would refuse codes the Stripe and Lemon Squeezy rails accept today — so the Paddle rail refuses a code it cannot mint, and says which characters. Paddle's own refusal is the string `"Invalid request."` with no field named.
- **`maximum_recurring_intervals` counts billing periods**, which is the unit `duration: { kind: "repeating", billingPeriods }` already uses. So the number passes through unconverted. Stripe's `duration_in_months` counts months, and that is where the translation happens. On an annual plan the difference is a year versus twelve years.
- **`usage_limit` counts a redemption only when money moves, so it does not stop a staff comp.** Paddle's reference says a usage is counted on "a checkout, transaction, or the initial application against a subscription". The third clause does not hold, measured on the sandbox on 2026-08-14. A 50% recurring discount minted with `usage_limit: 1` (`dsc_01m00hz66ad39h03cp6peg6a37`) was applied through `PATCH /subscriptions/{id}` to `sub_01kzybw2j7rx079j091erzhp07` and then, with the limit already notionally spent, to a second subscription `sub_01kzybqsn1n00ddff56z2s239k`. **Both succeeded, and `times_used` stayed `0`.** It went to `1` when a transaction billed under the code completed, and `POST /transactions` naming the same `dsc_…` was refused after that — *"Discount usage limit has been exceeded"*. Both subscriptions still carry the discount today, on a limit of one. So `maxRedemptions` stops a customer redeeming twice and does not stop staff comping twice: a comp flow that applies discounts by updating subscriptions has no guard at the provider, and needs its own record of who was offered a code. Pithy does not keep a counter to compensate — a local count would be a second answer to a question the store already answers, and it would be wrong the moment a code is redeemed anywhere Pithy is not watching.

`redeemableUntil` maps to `expires_at`, which stops **redemption**: after it the code cannot be claimed, and anyone already holding the discount keeps their rate for its full duration.

## 15. The customer portal

`POST /payments/portal` takes **no body at all**. There is exactly one Paddle customer this caller may manage — the one on the provider-account row for the subject they are acting for — and the subscriptions asked about are read from that subject's own rows. A field naming either would let any signed-in caller mint authenticated cancel links against somebody else's subscription.

The response carries the overview page plus, per subscription, a cancel link and an update-payment-method link.

**Treat every one of those URLs as a bearer credential for that customer's billing.** Paddle's overview link carries a `pga_` token whose lifetime is **24 hours**, with scopes covering `customer.subscription.update`, `customer.customer.update` and `customer.transaction.create`. Never cache one, never persist one, never log one, and never put one anywhere a `Referer` header would carry it onward.

There is **no `portalReturnUrl`**. Paddle's portal takes no return parameter, so `paddle.portalReturnUrl` is refused by config rather than accepted and dropped — a return URL you wrote that nothing reads is a lie in a file you trust.

## 16. Reconciliation, and the sweep only this rail can do

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
