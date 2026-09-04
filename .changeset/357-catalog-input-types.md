---
"@pithy-sh/payments": patch
---

The barrel publishes every piece a catalog is assembled from, and a test says so.

A catalog written in TypeScript — products built from a map of price ids, which is what makes those ids swappable between a sandbox account and a live one — needs a name for each piece it builds, and the *input* name rather than the output one: typing an unparsed product with `PaymentsProduct` demands `entitlements` and `clawback` back from an author the schema is about to default for.

`PaymentsProductInput`, `PaymentsRailTogglesInput` and `PaymentsStripeSettingsInput` were already declared and already on the barrel. `PaymentsPaddleSettingsInput` was not, and neither were `PaymentsPaddleProduct`, `PaymentsPaddleSettings`, `PaymentsLemonSqueezyProduct` or `PaymentsLemonSqueezySettings` — so two rails' catalog pieces were reachable only by deep path while Stripe's were not. All five are exported from `src/index.ts` now.

The rule is in a test rather than in this sentence: **everything `src/config/config.ts` exports, the barrel publishes.** It is derived from the source on every run, so a new export enrolls itself and a barrel edit that drops one goes red. `config.ts` is the one module an adopter writes against rather than calls, which is why it gets that rule and the rest of the package keeps the narrow one.
