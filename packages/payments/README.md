# @pithy-sh/payments

Three payment rails — Apple, Google, Stripe — resolving to one cross-rail entitlement, in your own Worker and your own D1.

Buy Pro on iOS, be entitled on the web. That resolution is the whole product, and it is the same one **[RevenueCat](https://www.revenuecat.com)** built a very good business on — their SDKs, their store-quirk coverage, and their dashboards are genuinely ahead of this package, and if you want a hosted product with a support contract you should buy theirs. The honest difference is not the feature list. It is **where the purchase history lives**: RevenueCat is a hosted data plane holding your customers' transactions, and this is four tables in a D1 you own, written by a Worker you deploy. Nothing here calls a Pithy-operated service, because there isn't one. That is principle 1 with a concrete competitor to point at, and it is what "the wiring is the differentiator" means when the wiring is money.

## A product is not an entitlement

This is the load-bearing distinction, and getting it wrong is the mistake worth naming first.

`pro_monthly` and `pro_annual` are two products. Each is listed in three stores' catalogs under three different SKUs. Between them they grant **one** entitlement — `pro`. Gating code names the key:

```ts
app.get("/reports", requireAuth(), requireEntitlement("pro"), handler);
```

Nothing outside the catalog ever names a SKU. Add an annual plan, launch on a fourth store, rename a Play product id — the gate above does not change, and neither does anything that reads it.

## Add it

```
pithy add payments                # installs, writes the config and the bindings, runs the migration
pithy payments provision          # deploys the reconciliation Workflow and writes its binding
```

`add` touches no Cloudflare account: it installs the package, writes the `payments({ ... })` block into `pithy.config.ts`, wires the `DB` binding into `wrangler.jsonc`, and runs the migration that creates `pithy_payments_purchases`, `pithy_payments_entitlements`, `pithy_payments_provider_accounts`, and `pithy_payments_webhook_events`. It works offline and in CI.

`provision` is the step that needs credentials. The `PAYMENTS_RECONCILE` binding arrives with it rather than with `add`, because wrangler requires a `name` and a `class_name` on every `workflows` entry and the deployed name is per project and environment (`<project>-<env>-payments-reconcile`) — an entry short of either field does not degrade, wrangler refuses to load the config at all. The binding is **optional**: an unprovisioned project still verifies receipts, accepts webhooks, and resolves entitlements.

`@pithy-sh/secrets` is **required** — every rail's credentials are read through it, so payments will not compose without it. `@pithy-sh/auth` is optional and strongly implied: purchases scope to the caller from the core `AuthContext` seam, so with no auth capability composed `c.var.auth` is null and every route denies. That is the right default and not a useful one. `@pithy-sh/ledger` is optional and only reached by products whose catalog entry declares `grants`.

Then set up the stores. That is the part nobody can do for you, and it has its own docs:

- [Apple in-app purchase](docs/apple-iap.md)
- [Google Play Billing](docs/google-play-billing.md)
- [Stripe](docs/stripe.md)

## Configure

**The catalog lives in `pithy.config.ts`, not in D1.** A product's entitlement mapping is policy: it should be diffable in git and it should not be mutable at runtime. The cost is that a new SKU needs a deploy, which is the correct trade — a table a mis-click or an attacker can edit decides who is entitled to what.

```ts
payments({
  rails: { apple: true, google: true, stripe: true },
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
      apple: { productId: "com.acme.pro.monthly" },
      google: { productId: "pro_monthly" },
      stripe: { priceId: "price_1Abc" },
    },
    remove_ads: {
      type: "non_consumable",
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
      google: { productId: "remove_ads" },
    },
    coins_100: {
      type: "consumable",
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      apple: { productId: "com.acme.coins100" },
      google: { productId: "coins_100" },
    },
  },
});
```

A product declares rails selectively. `remove_ads` shipping on mobile only is expressed by **omitting** the `stripe` block, not by a flag, so the config reads as the catalog it is.

The catalog is parsed at assembly, and it refuses more than it accepts. A SKU for a rail that is off, a rail that is on with no SKU anywhere, a product that grants nothing at all, a `grants` clause on a `non_consumable` (bought once, restored forever — the credit would fire again on every restore), two products claiming one SKU on one rail (a webhook resolves a product by its rail SKU, so a duplicate makes that ambiguous), or the Stripe rail enabled with no return URLs — each fails on deploy rather than on the first webhook.

`basePath` (`/payments`) moves the mount, webhooks included. `graceGrantsAccess` defaults to true, because that is the point of grace: a failed card should not lock a paying subscriber out mid-period.

## One writer, three triggers

Every write converges on a single idempotent projection keyed on `UNIQUE (rail, providerTransactionId)`.

- **Client submission** — the buying user's app posts its receipt. Exists only so the purchaser sees their entitlement immediately.
- **Provider webhook** — authoritative. Produces the identical row.
- **Reconciliation Workflow** — repairs drift from missed deliveries.

Because all three share a writer, **replays are free**. A dropped client call costs nothing. A replayed webhook changes nothing, and a replayed *transaction* is a 200 carrying the existing purchase rather than an error, because idempotency is a property of the write path and not an exception to it. Refunds, renewals, and revocations need no handling of their own either: they are states, and this projects a state.

The four properties are enforced by the database rather than by careful code — the UNIQUE constraint, an owner check on the `ON CONFLICT` branch as well as on the pre-read, the environment comparison, and the monotonic predicate below. The entitlement rows are re-derived **in the same `DB.batch` as the purchase write**, from the purchases table itself rather than from a value the writer computed, so there is no window in which a purchase is stored and its entitlement is not.

### The monotonic rule

**The projection is monotonic on the provider's own event time.** An event no newer than the row it would update is ignored entirely.

Providers do not guarantee delivery order. An `expired` notification can arrive after the `renewed` that superseded it, and last-write-wins would then silently revoke a paying subscriber — a defect that produces no error anywhere, and one the subscriber reports rather than your monitoring. So the comparison is on the store's own timestamp, and it is a SQL predicate as well as a pre-read, because two concurrent writers cannot order themselves correctly on their own.

The rule cuts both ways, which is why **a client submission is never dated by our clock when what it read is a snapshot.** A completed Stripe Checkout Session is immutable: `payment_status` reads `paid` for ever, refund or no refund. Dated now, re-posting the `cs_…` id from the success URL would outrank the refund already projected against that payment intent — the session names its own purchaser, so every owner check passes — and re-grant the purchase permanently. So a one-time session is dated by Stripe's own clock (the charge, or the session's creation), the retrieve expands `payment_intent.latest_charge` so a refund is visible at all, and only a status that grants nothing may be dated now. A submission that read *live* state — an expanded subscription, an App Store transaction, a Play lookup — is genuinely the freshest fact anyone holds, and the clock is the honest date for it.

### Entitlements are read from a row, and rechecked on read

Entitlements resolve from a materialized D1 row per request. No KV cache, no token claims — so a revocation is immediate and the truth has one home.

The row is written only by the projection. What is never stored independently of the purchase state is the entitlement itself, and the **read applies `expiresAt` again**: a subscription can lapse with no notification arriving at all, since the store simply stops renewing. The stored `active` flag is an optimization; the timestamp is the truth. A row saying `active = 1` with an expiry in the past does not grant, and it does not need a write to stop granting — a read never writes, because repairing a stale row is the Workflow's job and the hot path stays one indexed lookup.

Lapsed rows are returned with `active` false rather than filtered out, so a paywall can say "your Pro ended on the 4th".

A user is entitled when some purchase granting that key sits in `active`, `in_grace`, or `canceled` and `now < expiresAt`. **`canceled` does not mean unentitled** — turning off auto-renew forfeits the next period, not the one already paid for.

### A catalog edit is a write the read model has to follow

The derivation reads the catalog, so editing the catalog changes what an entitlement row should say — with no event to trigger it.

Drop `beta` from a product's `entitlements` and ship, and every user holding `beta` holds it with nothing behind it. No purchase for that key will ever arrive again, the read path only lapses a row carrying a dated expiry, and reconciliation re-asks about subscriptions — so nothing repairs it. The projection therefore re-derives more than the keys the event's product grants: it also clears **every non-manual key this user holds that no current product grants**, on that user's next purchase event, whatever the event was about. A support comp is held and survives, because a key the catalog never sold is a human's decision and not a derivation's.

The other half of a wide catalog is D1's hundred-parameter ceiling. The derivation names its candidate products **once**, as a CTE, and binds them as a single JSON parameter that SQLite's `json_each` expands back into rows — so two hundred products granting `pro` bind exactly what one does. Not a tuning detail: the derivation shares the purchase write's batch, so a statement over the cap meant no purchase touching that key could be recorded at all.

### The nine statuses, and the two questions they answer

Every rail's vocabulary maps into nine normalized statuses. Each answers two questions independently: does it grant access, and did its money ever arrive.

| Status | Grants | Credits a `grants` clause | What it means |
| --- | --- | --- | --- |
| `active` | yes | yes | Paid and current. |
| `in_grace` | by policy | no | A failed renewal still inside the retry window. |
| `on_hold` | no | no | A payment outstanding — retries exhausted, or a deferred payment still settling. |
| `canceled` | yes | yes | Auto-renew off, with the paid period still running. |
| `expired` | no | yes | A period we **were** paid for has ended. |
| `never_paid` | no | no | It terminated before any money cleared. |
| `refunded` | no | no | Money went back. |
| `revoked` | no | no | The store took it back. |
| `paused` | no | yes | A subscription the user suspended. |

**`expired` and `never_paid` are the pair to read twice.** They look alike — both are over, neither grants — and they differ on the only question a balance cares about. A bank debit that bounced (`checkout.session.async_payment_failed`), a Stripe subscription abandoned at `incomplete_expired`, a Play deferred purchase cancelled before payment: all three end with no charge, and reading them as `expired` credits a 100-coin pack for money that never arrived — with no clawback ever to follow, because there is nothing to reverse. Apple maps nothing to `never_paid`: StoreKit issues no transaction until the money moves.

**`in_grace` is a status and a date, and the date is the half that is easy to get wrong.** Grace only grants if `expiresAt` covers the retry window, and the paid period's end is not that date — by the time a store says "grace", the period has already ended. Apple reports the window on the renewal info beside the transaction (`gracePeriodExpiresDate`), so the Apple rail carries the later of the two; reading the transaction alone records a grace period and revokes the subscriber in the same commit, which is the opposite of what grace is for. Stripe and Play each report one expiry that already covers it: Stripe advances `current_period_end` when it invoices the next period, whether or not the charge clears, and Play extends a subscription's `expiryTime` through the grace period.

### Sandbox isolation

**Every purchase carries its store environment, and a mismatch is refused outright.**

A sandbox StoreKit transaction granting a real entitlement is the most common in-app-purchase security defect there is, so no such row is ever created. The environment is an input from this deployment's own `ENVIRONMENT` var, never inferred from the payload — inferring it from what the store said is exactly the hole. Only a Worker deployed to `prod` is production; `staging`, `dev`, and a var nobody set are all sandbox, because the failure directions are not symmetric. Treating production as sandbox loses a purchase reconciliation repairs; the other way round hands out entitlements for test transactions.

## Routes

| Route | Purpose | Verification |
| --- | --- | --- |
| `POST /payments/purchases` | Submit a receipt or signed transaction for verification | bearer · session |
| `GET /payments/entitlements` | The caller's own resolved entitlements | bearer · session |
| `POST /payments/restore` | Restore Purchases — rebind store history to the caller | bearer · session |
| `POST /payments/checkout` | Stripe only. Create a hosted Checkout Session | bearer · session |
| `POST /payments/portal` | Stripe only. Create a Billing Portal session | bearer · session |
| `POST /payments/webhooks/apple` | App Store Server Notifications V2 | signed-webhook |
| `POST /payments/webhooks/google` | Play Real-time Developer Notifications, via Pub/Sub push | signed-webhook |
| `POST /payments/webhooks/stripe` | Stripe events | signed-webhook |
| `POST /payments/entitlements/grant` | Comp or repair an entitlement | control-plane |
| `POST /payments/entitlements/revoke` | Take one back | control-plane |

**No `public` routes.** Every caller is either an authenticated user acting on their own purchases or a machine proving authenticity. Turnstile has nothing to gate here.

**`signed-webhook` is one strategy over three unrelated mechanisms.** Apple signs a JWS against a certificate chain pinned in the package; Google's Pub/Sub push carries an OIDC token verified against Google's published keys with an audience check; Stripe sends an HMAC in `Stripe-Signature` inside a timestamp tolerance. Each covers the **exact received bytes**, which is why these are ten literal paths rather than one `:rail` — a single route line could not carry three verifiers, and the rail a caller *claims* is not something to route on.

Nothing is recorded for a delivery that fails verification, so a forger cannot fill the table. A delivery that verifies is recorded before it is processed, keyed on the store's own event id, and a redelivery already processed short-circuits with 200 — which is what makes at-least-once retries free and "why didn't this renew" answerable.

**What the handlers never trust.** The product comes from the verified payload's SKU, never the request — a client-supplied product id would let a caller present a cheap receipt as an expensive product. The owner comes from the auth seam or the provider-account map, never a body. The return URLs come from config, because a client that could name one could send a paying customer to a page it controls. The purchaser on a Checkout Session comes from `c.var.auth`, so no caller can attach a purchase to another account.

**Manual grant and revoke** are `control-plane`, default-denied until you provision a scoped credential, and audited on both paths — they are the only way an entitlement appears without money moving.

A grant is **held** against the projection. Every other row in the entitlements table is recomputed from the purchases table whenever a write touches its key, which is what keeps the read model from disagreeing with the money — and it is also what would have erased a comp of `pro` the moment the user's next renewal arrived. So a grant sets a flag the derivation skips, and a comp lasts whether or not the catalog also sells the key.

**A grant must name a key this project defines.** `GET /payments/admin/catalog` is the read behind it, on its own scope — `payments:catalog:read` — and it publishes each product's id, kind, display name, and entitlement keys. Strictly less than the client projection a browser already gets: no price, no store SKU, no rail identifier, because a management client is filling a list of things that can be comped and a comp names a key. An empty catalog answers `{ enabled: false }`, the same modelled state the client projection uses, so "nothing to sell" reads as itself rather than as a dropdown that came back broken.

The read makes a good control possible; the check on the grant makes a bad one impossible. `POST /payments/entitlements/grant` refuses a key outside that set with `payments/entitlement_not_in_catalog`, naming the key. Before it did, an operator who meant `pro` and typed `pr` got a success, a row, and a customer who stayed locked out — invisible on both sides until somebody read the table.

Gating on a key nothing sells is legitimate, and the escape is **declared** rather than achieved by not checking: put it in `manualEntitlements`, and it is grantable and offered on the catalog read beside the products. Only grants are constrained. A revoke of a key the catalog has since dropped stays legal, or a catalog edit would be irreversible for every account still holding it.

A revoke **releases** the hold rather than setting it. That asymmetry is deliberate: it makes a revoke the exact inverse of a grant, and it stops a revoke becoming a permanent block on a user who later pays. An entitlement the purchases still support is re-derived on the next event, so revoking a paid subscription here holds only until the store next says something about it. To end a paid entitlement, refund it through the store — that is the record the projection reads, and the only one that keeps the read model and the money agreeing.

## Errors

Runtime code throws `PithyError` with `payments/*` codes. Internal detail never reaches a client — a store's raw error text, a receipt, a signature, and a purchase token all live in `detail`, which the HTTP codec strips.

| Code | Status | Meaning |
| --- | --- | --- |
| `payments/invalid_receipt` | 400 | The receipt could not be read at all. Nothing was asked of the store. |
| `payments/verification_failed` | 400 | The store was asked and said no. |
| `payments/webhook_unverified` | 401 | An inbound notification failed its authenticity check. |
| `payments/rail_not_configured` | 404 | The rail is off, unprovisioned, or not implemented in this build. |
| `payments/product_not_found` | 404 | No catalog product maps that SKU or that id. |
| `payments/environment_mismatch` | 400 | A sandbox purchase reached production, or the reverse. |
| `payments/receipt_already_owned` | 409 | The transaction is already projected against another user. |
| `payments/provider_unavailable` | 503 | The store could not be reached. Retry; reconciliation repairs it either way. |
| `payments/clawback_failed` | 409 | A refund's debit was refused by the ledger. |
| `payments/entitlement_required` | 403 | The caller does not hold an entitlement the route requires. Raised by core's gate. |
| `payments/entitlement_not_in_catalog` | 400 | A manual grant named an entitlement key no product grants and `manualEntitlements` does not declare. |

**`payments/webhook_unverified` is 401 on purpose, not by oversight.** 401 says "you did not prove who you are", which is exactly a failed signature; 403 says "you are known and not allowed", which a forged notification is not. It reads oddly next to the other webhook responses, so it is written down here — please do not "fix" it.

A rail being off, unprovisioned, or unimplemented are all one code, because from the caller's side they are one statement — that payment method is not available here — and distinguishing them in a response would describe your deployment to a stranger. `detail` distinguishes them for you.

## The entitlement seam

The contract lives in `@pithy-sh/core`, not here: the `Entitlement` shape, an `EntitlementResolver` on request `Variables`, `requireEntitlement(key)`, and `requireAnyEntitlement(keys)`. Payments is a *provider* that fills it, and other capabilities depend only on the seam.

**The uncomposed default denies**, which is the one deliberate difference from the audit seam. A missing audit write cannot grant anyone access; a missing entitlement check can. So the gate lives in core for the same reason `requireAuth()` is re-declared per capability rather than imported from `@pithy-sh/auth` — a gate that arrives with a package fails **open** when that package is absent. Denials are audited through `emit()` as `entitlement/denied`, and the reason (genuinely unentitled, or nothing wired) rides in `detail` where an operator sees it and a client does not.

Runtime denial is the backstop, not the primary defence. `pithy doctor` and `pithy dev` compare the `requireEntitlement()` calls in a Worker's own source against whether any composed capability declares `providesEntitlements`, so a Worker gating on entitlements with no provider surfaces as a composition error rather than as production 403s.

## Ledger fulfillment

`grants` is the **only** point of contact with `@pithy-sh/ledger`, and it is opt-in per product. Most products never touch a balance: "remove ads" grants an entitlement and nothing else.

When a product declares one and both capabilities are composed, the credit goes through a guarded optional import, with the ref derived as `payments:grant:<purchaseId>:<currency>` — so double-crediting is prevented by the ledger's `UNIQUE (ref)` rather than by careful handler code. A `grants` clause on a **subscription** fires per billing period, because each renewal is a distinct provider transaction.

Every `grants.currency` is validated against the composed ledger's declared currencies at assembly. That check exists because the failure is otherwise invisible: `openLedger` validates nothing, so a typo opens a real account row nobody can reach — the ledger's own routes resolve a currency from config and 404 an unknown code — and the player is told their purchase worked.

**Clawback on a refunded consumable is opt-in too**, and off by default. The debit can be refused by the ledger's overdraft guard, and that refusal is correct behaviour: routing around it would mean a negative balance or a silent write-off. So payments records the refund and audits it unconditionally, and a failed clawback becomes a recorded, queryable, alertable state rather than an exception.

## Reconciliation

A Cloudflare Workflow on a daily cron, because **webhook-only systems rot silently**. A deploy that drops requests, a misconfigured Pub/Sub push subscription, a provider outage, a rotated signing key — each loses events with no error surfacing anywhere.

Steps: select subscriptions near expiry or not recently verified, re-fetch current state from the rail, and project it through the same idempotent writer. Drift found is itself audited, because repeated drift means the webhook path is broken and the number is the signal.

A repair also **fulfils**. A renewal the webhook never delivered is the case this pass exists to find, and a `grants` product's coins have to be credited by whoever finds the period or they are never credited at all. Fulfillment runs on drift only: every rail dates a refresh `now`, so the writer reports a write for every row a pass touches, and keying on that would mean one ledger call per scanned row per pass against a ref that already exists. The credit is safe to attempt twice regardless — the ref is a pure function of the purchase and the currency, and the ledger's `UNIQUE (ref)` makes the second one a no-op.

The same steps run for one user on demand, which is the support tool for "my subscription isn't showing up":

```
pithy payments provision [--json]
pithy payments reconcile --env staging [--user <id>] [--rail apple|google|stripe] [--dry-run] [--json]
```

Both prompt for nothing, are safe to re-run, and take `--json` — an agent and a human drive the same command.

## Client surface

**Headless in the package, presentation in your repo.** `pithy ui add` writes a file once and may never rewrite it, which is the right ownership rule and is exactly why a frozen paywall ages badly: store rules move under it — price-change consent prompts, external purchase link entitlements, subscription-management requirements — and a purchase flow in your `.tsx` is one Pithy cannot fix for you.

So the surface splits by what changes. The hooks own the calls, the redirect-and-return dance, the error mapping and the entitlement reads, and upgrade with a minor release:

```tsx
import { useCheckout, useEntitlement } from "@pithy-sh/payments/src/client/hooks";

const { entitled, loading } = useEntitlement("pro");
const { start, starting, failure } = useCheckout();
```

Four of them — `useEntitlement`, `useSubscription`, `useCheckout`, `usePurchase` — over a framework-free `src/client/api.ts` that a non-React client can call directly. **Nothing here throws**: a read that fails reads as "not entitled", because the server's `requireEntitlement()` is the boundary and failing closed in a browser costs nothing.

`react` is an **optional** peer dependency and neither client module is exported from `src/index.ts`. That is what keeps React out of a Worker bundle that composes payments; both are reached by their own deep path.

`pithy ui add react` scaffolds the paywall and subscription screens that call them, plus an entitlement route guard — offered when the Worker composes payments, and forced either way with `--payments` / `--no-payments`. The web scaffold sells on **one rail** — StoreKit and Play Billing need native code to present a purchase sheet — so Apple and Google products display and link to their stores while Stripe products carry a buy button. `docs/UI.md` has the details.

`virtual:pithy/payments` carries only what a browser may know: the enabled rails, the base path, and per product its id, type, entitlement keys, display name, and Stripe price id. A price id is publishable by design — it is what a Checkout Session names. Apple's and Google's SKUs, the `grants` block, and every credential stay server-side, and a test sweeps the serialized projection for each credential shape.

## Testing

No test reaches a live store. Rails are tested against recorded, redacted provider payloads — a real App Store Server Notification V2 JWS, a real RTDN envelope, real Stripe events — with test signing material standing in for production chains: a generated certificate chain for Apple, test OIDC keys for Google, a known signing secret for Stripe. **Signature verification is genuinely exercised rather than stubbed**, because it is the security boundary on three of the ten routes, and the trust seam that makes that possible is additive only — no caller can narrow production's trust set, and it is not reachable from config.

`bun run test` runs both projects. The **node** project covers the pure logic: the catalog, the status mappings, the JWS and HMAC verifiers, the client API. The **workers** project runs under Miniflare against a real D1, which is where the migration's `up` and `down`, every UNIQUE and CHECK constraint, and the projection's idempotency properties are proved.

The idempotency battery is the highest-value suite in the package, since "one writer, three triggers" is the claim the design rests on: apply the same event repeatedly, interleave a client submission with its webhook and a reconciliation pass, vary the order. The terminal state is one purchase row, one entitlement, one ledger credit, every time. Four cases are non-negotiable and each is the defect this capability attracts — out-of-order delivery, sandbox isolation, a fail-closed gate with no provider composed, and a cross-user receipt replay.

`pithy seed` writes three example purchases for the shared cast in `docs/SEED.md`: Ada holds a live Apple subscription, Grace a Stripe non-consumable she owns forever, Alan a refunded Google consumable. One row per rail, one per product type, and the three states anything reading this table has to handle. `dev` and `staging` only.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
