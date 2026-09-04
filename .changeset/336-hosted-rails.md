---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
---

One list of the rails that sell in a browser, and every screen reads it.

A Paddle-only project scaffolded a subscription screen with no way to reach a billing portal. The gate said `rails.stripe || rails.lemonSqueezy`, and the server minted Paddle portal sessions the whole time. It was the third hand-written copy of the same list, added under a comment describing the second one.

`PAYMENTS_HOSTED_RAILS` is now the list, exported from `@pithy-sh/payments/src/client/api` for the browser and `src/data/rail.ts` for the Worker. The subscription screen, the paywall, `/checkout` and `/portal` all read it. **A template that imports it keeps up with a rail added after it was copied**; three names typed into a file freeze on the day they are typed, which is the whole of this defect.

**One name, not two.** "Sells in a browser" and "mints a portal we can link to" are the same set, and not by coincidence: `CheckoutRail` declares `createCheckoutSession` and `createPortalSession` together, so a rail cannot have one without the other. `providers.test.ts` builds every rail in the enum and compares the list against the ones that actually satisfy `isCheckoutRail` — so the day a rail sells without a portal, the interface splits, that comparison goes red, and a second name arrives with a failing test rather than a judgment call.

**A second defect of the same shape, found and fixed.** `isPurchaseView` narrowed `rail` against a runtime set that Paddle had never been added to, so every Paddle purchase the routes returned read as unreadable in a browser. The union's *type* had a drift guard; the set the guard actually compares against had none. It does now, and it asserts through the exported behavior rather than the private array: every rail in `PAYMENTS_RAILS`, one at a time, must survive the guard.

The subscription screen takes its rails as a prop and is rendered against one project shape at a time, the way `SignInScreen` already was — a Paddle-only project, an Apple-and-Google-only project, a project with nothing on. And a sweep over the scaffolded screens refuses a set of hosted rails written out by hand: naming one rail is a screen about that rail, and `pricing.tsx` is Paddle's for a real reason. Naming two is a list somebody typed from memory.
