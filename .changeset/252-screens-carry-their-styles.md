---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

Pithy's screens carry their own stylesheet, so a backfill renders styled

`pithy ui add react --auth` on a project scaffolded `--no-auth` wrote `routes/pithy/sign-in.tsx` and
reported it as `created`. The screen rendered `stack`, `divider` and `secondary` — classes defined only in
`src/styles.css`, the file the same run correctly skipped because it is the adopter's. The first sight of
the feature they had just enabled was an unstyled login page, on a product whose pitch is that the design
is the product.

Skipping the stylesheet is right. Keeping the rules in it was not: a screen and the rules it needs are one
artifact, and ownership had split them.

So the templates now ship **`src/pithy-screens.css`**, holding every class name a Pithy screen renders, and
the screens import it themselves. It is written whenever it is absent, so the run that writes a screen
writes its rules; `src/styles.css` stays the adopter's and is never touched.

Two properties keep it safe to live beside a design someone else owns. Everything sits in a `@layer pithy`
cascade layer, and unlayered CSS beats layered CSS regardless of order or specificity — so any rule an
adopter writes wins with no `!important` and no regard for import order. And the palette is six tokens read
with fallbacks (`--bg`, `--surface`, `--fg`, `--fg-muted`, `--border`, `--accent`): declare them and the
screens adopt your colors, declare none and they stand up on their own, following `prefers-color-scheme`.

Two gates keep it true, because the drift that produced this runs in both directions. A test extracts every
`className` the screens render and every selector the stylesheets define and requires the first to be a
subset of the second — a screen gaining a class nothing defines now fails CI. And `pithy ui add` checks the
result rather than assuming it: after writing, it reads the stylesheets actually on disk and reports any
class the screens render that none of them defines, as `unstyled` under `--json`. Wrote the screens and the
screens are styled are two claims, and only the first was ever made.
