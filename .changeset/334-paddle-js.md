---
"@pithy-sh/payments": minor
"@pithy-sh/ui-react": minor
---

Load Paddle.js, and read every price from Paddle for the visitor looking at it.

The Paddle rail shipped a complete server and a client that could only redirect. Nothing in the kit loaded Paddle.js, so the projection's `clientToken` had no reader and the half of the rail that was the argument for choosing it did not exist.

`src/client/paddle.ts` is that half. `loadPaddle` initializes Paddle.js once per page from `paymentsConfig.paddle`, with `Environment.set` matching the environment you declared and never guessed — and a second call naming a different account is refused rather than re-pointing an initialized Paddle at another one. A load that produced nothing is not remembered, so a retry is a real retry. `initializePaddle` swallows an initialization error into a `console.warn` and resolves anyway, so the loader checks the flag Paddle.js sets itself; without that a bad token reads as a working Paddle whose every call quietly does nothing.

`usePricePreview` is the pricing half, beside `useCheckout` and `useSubscription`, with a `pricing.tsx` template that renders it. **No screen this kit ships contains a price string, and a test over the template tree holds it to that.**

Measured against the live sandbox on a $5.00/month price, because "localized" is a claim that has to be checked rather than repeated:

- **Currency is not localized without `unit_price_overrides`.** A preview from a British or German address on a USD price comes back in dollars. Currency is catalogue data. What localizes without it is tax and formatting, which is real, and is not the same claim.
- **The tax convention differs by country and it is not formatting.** New York pays $5.44 on a $5.00 subtotal; the UK pays $5.00 on a $4.17 subtotal; Germany $5.00 on $4.20. One string cannot mean "before tax" in Denver and "including VAT" in Berlin, so `priceSummary` returns the figure to show and the sentence that makes it true, derived from the numbers Paddle returned rather than from a country table.
- **United States tax resolves at the postal code.** 15% in Chicago, 8.875% in New York, 0% in Oregon — and 0% for the country with no code at all, which quotes $5.00 to a buyer whose card is charged $5.44. A quote with no postal code is marked `estimated` and says tax is settled at checkout rather than implying there is none.
- **Zero-decimal currencies are whole units.** ¥725 is `725`. Nothing here formats a raw amount; `formattedTotals` is Paddle's own rendering and already right.

The in-flight state is `preview: null, loading: true` — a screen holds the space. The failed state is `preview: null` with a renderable failure and **no fallback figure**, because a number written into a template is wrong in every country whose convention differs from the one it was written in, and wrong silently.

Every response is narrowed by a hand-written guard before a screen can reach a field of it: Paddle's answer crosses a trust boundary, and half a price is worse than none. The only credential in the browser is the publishable client token, and a sweep over `src/client/` gates that rather than a comment claiming it.
