---
"@pithy-sh/payments": patch
"@pithy-sh/ui-react": patch
---

The pricing screen stops racing its own quote, and says which prices are estimates.

Four defects from the review of #334 and #335, on the one screen whose entire job is showing a correct price.

**A superseded quote no longer wins by arriving late.** Two `PricePreview` calls can be in flight at once — an anonymous visitor's location resolves under the query, or a country picker moves — and `usePricePreview` rendered whichever answered last. It now renders whichever was asked last: every quote takes a ticket, and only the holder of the newest writes state. The superseded answer is *ignored*, not cancelled — Paddle.js takes no `AbortSignal` and hands back a bare promise, so there is nothing to cancel. A superseded *refusal* is ignored the same way, which is what stops a dead request blanking a price the visitor is already reading. Driven with two real in-flight requests answering out of order, against recorded sandbox quotes for two countries.

**An estimated quote looks estimated.** `priceSummary` returns `{ headline, note, estimated }` and the scaffolded screen rendered the first two. United States tax resolves below the country, so a country-only quote comes back at 0% and the card is charged more — Paddle answers `postalCode: ""` rather than an error, which is why the flag exists. The screen now renders *Estimated.* beside the figure. Show what you know, label it, recalculate at the billing address: an estimate that resolves at checkout is correct behaviour, and the label was the half being dropped.

**One mount opens one checkout, under `StrictMode`.** Which is the mode `pithy ui add react` scaffolds — `client.tsx` wraps the router in it — so every adopter developing against Paddle got two overlays per buy click. `usePaddleCheckout` remembers the transaction it opened rather than trusting its effect to run once, and remembers the last id rather than a flag, so a second attempt (a second transaction) still opens.

**The anonymous visitor is offered the way in, by name.** The pricing screen is public, because a stranger has to be able to read a price; `POST /payments/checkout` is `requireAuth()`, so its only action is not. A stranger used to get a Buy button, a refusal, and a redirect away from what they were doing. They now get one sentence and a sign-in link in place of the button, before the click. The price stays on screen either way.

`PricingScreen` is exported with props, the way `SubscriptionScreen` already was: which control a visitor is offered and whether a quote is labelled are *rendered* facts, and no assertion about source text reaches them. `useSignedIn` is exported from the scaffolded router so a public screen can ask the question without being guarded by it — through the same optional glob, so a payments-only scaffold with no `session.tsx` still compiles and renders.
