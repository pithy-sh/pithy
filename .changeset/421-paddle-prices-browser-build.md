---
"@pithy-sh/payments": minor
---

The quote path ships as a browser build, so two surfaces stop reimplementing it. `dist/paddle-prices.iife.js`
is one classic script a static site loads: it reads its Paddle account and its plan-to-price mapping off
its own `<script data-paddle-*>` tag, and writes each formatted total — and the tax sentence that makes
it true — into the page's `[data-price-plan]` and `[data-price-note]` slots.

It goes through `readPricePreview` like every other reader here, which is the point of it. `#416` was the
marketing site's hand-written copy of this mechanism being right for months while this package's reviewed
copy was wrong, and nothing ran both. Now one thing runs, and its test loads the built artifact in a DOM
and answers it a recorded `{ data, meta }` envelope — against the built file, because the built file is
what a site loads.

An unconfigured tag quotes nothing rather than quoting wrong. A missing environment, a token that does
not match it, a `REPLACE_WITH_…` placeholder in any one id: all refused before Paddle is fetched at all,
with every slot still holding the sentence the page shipped with. The rail is named on the tag and in the
artifact, never in the markup, so a pricing page's slots outlive the choice of provider — and
`data-paddle-paint="off"` hands the same `PaymentsResult` to a page that keeps its own cache or its own
formatting.

`previewPrices` also answers a refusal where it previously threw: Paddle.js validates a query
synchronously, so one it rejects outright threw past the handler pair and out of the function, which was
an unhandled rejection on the page in place of a `PaymentsFailure`.
