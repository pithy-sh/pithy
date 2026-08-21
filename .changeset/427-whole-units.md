---
"@pithy-sh/payments": minor
---

Ask for prices in whole units, and let the kit be the one that gets it right.

`#421` shared the quote so two surfaces would stop reimplementing it. They then reimplemented the *formatting*: `pithy-sh/dashboard`'s `withoutZeroFraction` in `apps/board/src/billing/quote.tsx` and `pithy-sh/marketing`'s `trimZeroFraction` in `raw-content/src/static/js/prices.js` are `total.replace(/([.,])00(?=\D*$)/, "")`, byte for byte, in two repositories. **Both can now be deleted.** `wholeUnits: true` on `quotePlans` — or `data-paddle-whole-units="on"` on the script tag — replaces them, and the marketing file's own comment saying this belongs upstream can go with them.

**Opt-in, never a default.** Only an all-zero fraction ever goes, so a seller pricing at `$6.99` is unaffected either way — but which figures a page advertises is a pricing decision and the kit does not make it for anybody. Not asking, asking for `false`, and mistyping the attribute all leave every figure exactly as Paddle rendered it, on every recorded fixture, asserted.

**The decision is arithmetic, and only this package holds the number.** Paddle sends each figure twice — minor units for comparing, rendered for showing — so $6.00 is `600` and the fraction is zero when `amount % 10 ** places === 0`. No parsing, no locale, no guess, and *is the trailing `000` in `$1,000` a fraction or a thousands group?* is never asked, because the answer is settled before the string is touched. Neither adopter could do that: the dashboard sees only `headline` and the marketing site only what the tag painted, and `totals` never leaves this package.

**The two copies were also wrong, in ways a regex over a formatted string cannot be fixed out of.** A three-decimal currency's whole-number price is `KD 6.000`, which a two-zero pattern never matches. An Arabic-Indic price is `‏٦٫٠٠٠ د.ك.‏` — a separator that is not a comma, digits that are not `0` — which it never matches either. That second one does not corrupt anything; it silently does nothing, which is the failure nobody sees. Both are trimmed now, and the fixtures are generated from `Intl.NumberFormat` rather than pasted, so a reviewer can regenerate any row.

**The removal never asks which character the separator is.** It is a property of the locale, not the currency — `de-DE` renders EUR as `6,00 €` and `en-IE` renders it as `€6.00` — and the browser cannot answer either, because `Intl.NumberFormat(undefined, …)` answers for the *visitor's* locale while the string came from Paddle. So the fraction is found positionally: a trailing run of digits in any script, one non-digit before it, and a digit before that. Symbols, spacing and bidi marks after the run are carried through. A run preceded by another digit is a thousands group and is left alone, which is what keeps `$1,000`, `1.000 €` and Spanish's ungrouped `1000 €` intact.

Only the headline. A tax sentence names a rate applied to a base rather than a price anybody set, so trimming it would put `$0.44` and `$1` in the same column.

`paddle.ts`'s "never format a price yourself" paragraph and `docs/paddle.md`'s "formatting stays with the page" both said, in effect, *write your own trim* — and two pages did. Both are amended and dated rather than deleted.
