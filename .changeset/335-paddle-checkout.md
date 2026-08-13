---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
---

Paddle checkout opens over your page, or inside it.

`POST /payments/checkout` has answered a Paddle handoff since the rail landed, and nothing opened it. Now
`openPaddleCheckout` and the `usePaddleCheckout` hook do, in both display modes, from the transaction the
server minted. The scaffolded paywall and pricing screens render their container from the handoff, so
switching `paddle.checkout` between `overlay` and `inline` needs no edit to a scaffolded file.

`config.paddle.successUrl` said of itself that it was "used as `settings.successUrl` for Paddle.js". It
was not passed anywhere. It now travels on the handoff and reaches Paddle, so a buyer who pays lands on
your return page in every mode — and it comes from config rather than the request, like every other return
URL here.

**A correction to the rail's security note, measured against the live sandbox.** `Paddle.Checkout.open`
accepts `customData` beside a `transactionId` and **overwrites** the `custom_data` your server wrote when
it created that transaction — same id, `origin` still `api`, owner now whoever the page said. Creating the
transaction server-side does not protect the ownership stamp; only the MAC does, and it always did. Both
forgeries are recorded from real paid sandbox transactions in
`src/rails/paddle/fixtures/browserForged.ts` and gated on.
