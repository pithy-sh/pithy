---
"@pithy-sh/payments": minor
"@pithy-sh/core": patch
"@pithy-sh/i18n": patch
---

A subscriber can change, end, or be refunded their plan.

`payments` could take a first payment and nothing after it. A subscription could be started and then
only watched: no upgrade, no downgrade, no cancellation, no refund, and no way to ask what any of
those would cost before committing to one. Every adopter who needed them wrote the rail calls
themselves, against the one API the capability exists to keep them away from.

`SubscriptionRail` is that seam, with `RefundRail` beside it as a separate contract — a store that
settles refunds is not necessarily one that manages subscriptions, and folding them into one
interface would make every implementer claim both. Paddle implements both. Six routes are mounted
under the capability's own base path: read the standing, preview a change, commit one, cancel, keep
a canceled plan, and refund.

**A quote is three parts, because a deferred downgrade has three**: what settles today, what lands
on the next invoice and when, and what the subscription pays after that. `SubscriptionSettlement` is
a discriminated union of `charge`, `credit` and `nothing`, because a credit and a charge are the
same digits and the opposite meaning, and a screen that renders a bare number gets to be wrong in
one direction without knowing it.

**Every quoted figure carries the string to print it with.** `QuotedMoney.rendered` is required, not
optional, so a caller cannot reach for the integer and format it themselves. `renderMoney` places
the decimal lexically rather than by division, and takes the exponent from ISO 4217's
`minorUnitDigits` rather than from `Intl` — those disagree. `Intl` carries CLDR *display* digits,
which round HUF and COP to whole units, and Paddle sells in both: `6582` HUF renders as `HUF 66`
through `Intl` and `HUF 65.82` through the denomination. A store's own formatted total is used where
the store provides one; `pricingPreview.preview` is the only Paddle endpoint that returns
`formatted_totals`, so the rest are rendered here.

`PaymentsSubscriptionChangeRefusedError` (409) is the refusal a store gives when a change cannot be
made — a plan already on that product, a subscription past its window. It is a stated outcome
rather than a failed request, and it carries the Spanish string with it.
