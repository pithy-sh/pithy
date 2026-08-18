---
"@pithy-sh/payments": patch
---

`previewPrices` returns a price again. `readPricePreview` read `currencyCode` and `details` at the top
level of Paddle's answer, but `PricePreview()` resolves `{ data, meta }` and everything a price is made
of is under `data`. Every real answer was refused, and because a refusal is deliberately not an error —
it arrives as `PAYMENTS_UNREADABLE`, which a screen renders as the absence of a number — the rail was
dead in the browser while the suite was green.

It was green because the five recorded sandbox answers were saved one level in, at `response.data`, and
the reader was written to agree with them. So the fixtures now carry the envelope, which is what the
reader is actually handed; with them at the right depth the old reader fails all twenty-two assertions
that touch them. A recording saved at the wrong depth is a gate that cannot fail.

An already-unwrapped record is still accepted, so an adopter who unwrapped before calling this is not
broken by the repair.
