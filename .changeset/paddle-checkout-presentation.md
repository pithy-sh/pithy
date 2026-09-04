---
"@pithy-sh/payments": minor
---

Let a screen say how its Paddle checkout looks.

`openPaddleCheckout` and `usePaddleCheckout` take `theme`, `locale` and `variant`, and pass them to `Paddle.Checkout.open`. Paddle defaults the theme to `light`, so an app in dark mode has been opening a light card form over a dark page.

**Nothing is inferred.** No `prefers-color-scheme`, no `matchMedia`, no sampled style. The machine's preference is not the app's theme, and an app with its own toggle would get a checkout contradicting the page it opened over. The screen knows; it passes what it rendered.

**Omitted stays omitted.** A setting nobody passed is an absent key, never a key holding `undefined` — these sit over the account settings configured in the Paddle dashboard, and a caller who said nothing must not overrule a seller who did.

Colors and fonts remain where Paddle keeps them: its own dashboard, under Checkout → Branded inline checkout. That is Paddle's product decision rather than a missing endpoint. `docs/paddle.md` now says so, with the reason.
