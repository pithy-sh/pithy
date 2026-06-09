# Pithy Brand Guidelines

> The brand is built around one idea: the period is the brand. Everything — color, type, spacing, voice — should reinforce concision as the differentiator.

---

## 1. Brand essence

Pithy is a Cloudflare-native, open-source backend kit. The name is the position: concise, opinionated, no bloat. The visual identity follows from that promise.

| Attribute | Direction                                                 |
| --------- | --------------------------------------------------------- |
| Aesthetic | Editorial minimal — Penguin Classics meets Linear         |
| Voice     | Confident, sharp, low ego, short sentences                |
| Mark      | A single saffron period                                   |
| Type      | Geist Sans + Geist Mono                                   |
| Colors    | Ink, parchment, saffron                                   |
| Modes     | Light and dark, auto-switching via `prefers-color-scheme` |

---

## 2. Logo

### 2.1 Wordmark

The wordmark is `pithy.` set in **Geist Sans Medium (weight 500)**, lowercase, with `-0.05em` letter spacing. The period is rendered in saffron; everything else takes the foreground ink color of its mode.

The wordmark is the primary brand signature. Use it whenever space allows.

### 2.2 Mark hierarchy

Beyond the full wordmark (Section 2.1), Pithy uses two derivative marks for contexts where the wordmark won't fit or won't read. All three marks share a single brand element — a saffron square — appearing at different scales of disclosure.

**The "p." mark — `pithy-social.svg`** is the wordmark abbreviated to its first letter and the brand period. Use it for square avatar contexts where there's enough room for two characters:

- GitHub organization avatar
- npm scope avatar
- X / Bluesky / Mastodon profile picture
- Discord server icon
- Any 32px-and-larger square where the brand needs identity without full width

The canonical version uses ink (#111111) background with parchment "p" and saffron period. A parchment-background variant (`pithy-social-light.svg`) exists for explicit light-only contexts.

**The brand mark — `pithy-favicon.svg`** is the period alone: a saffron square. It's the same shape and color as the period that renders in the wordmark, just isolated. Use it anywhere "p." would be illegible or where the brand needs to assert itself as the simplest possible symbol:

- Browser favicon (16px and up — the canvas is the mark; no container)
- Inline accent between words in marketing copy
- Watermark in screenshots, hero illustrations, video corners
- Loading states or spinners (with motion)
- "Built with Pithy" badges where surrounding text already provides context

This single SVG is the canonical mark asset. The same file works at every size from 16px to 1024px; layout and CSS handle whatever padding the context requires.

**Shape and color are non-negotiable.** The mark is a saffron (#D4A017) **square**. Never a circle. Never an outline. Never a gradient. Never any other color. The square shape matches the period as Geist Medium renders it — the brand mark and the typographic period are visually identical, which is the point.

**Apple touch icon and other branded home-screen contexts.** iOS applies its own corner radius to `apple-touch-icon` automatically. Use `pithy-social.svg` rendered at 180×180 — the "p." version with its ink background — not the bare favicon. When someone pins your site to their home screen, they want to see the brand, not a colored block.

**At-a-glance asset map:**

| Mark        | File                                                 | Use                                                                                        |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Wordmark    | `pithy-wordmark.svg` (+ `-light` / `-dark` variants) | Anywhere there's horizontal space — headers, docs, marketing                               |
| Social icon | `pithy-social.svg` (+ `-light` variant)              | Square avatar contexts, 32px and up                                                        |
| Brand mark  | `pithy-favicon.svg`                                  | Favicon, inline accent, watermark, anywhere a single saffron square communicates the brand |

### 2.3 Clear space

Maintain clear space around the wordmark equal to the **x-height of the lowercase letters** (`p`, `i`, `t`, `h`, `y`). No text, image, edge of container, or other graphic element should encroach on this space.

```
┌─────────────────────────────────────────┐
│ ←x→                                 ←x→ │
│ ↕x                                      │
│                                         │
│         pithy●                          │
│                                         │
│                                  ↕x     │
└─────────────────────────────────────────┘
```

For the standalone mark, the clear space is one full mark-diameter on all sides.

### 2.4 Minimum sizes

| Context | Wordmark          | Standalone mark       |
| ------- | ----------------- | --------------------- |
| Screen  | 80px wide         | 16px square           |
| Print   | 1 in / 25 mm wide | 0.25 in / 6 mm square |
| Favicon | not used          | 16px square minimum   |

Below minimum size, switch to the standalone mark. Never display the wordmark so small the dot of the `i` and the period become indistinguishable.

### 2.5 Light & dark variants

The wordmark adapts; the period does not.

| Mode  | Wordmark text       | Period            |
| ----- | ------------------- | ----------------- |
| Light | Ink `#111111`       | Saffron `#D4A017` |
| Dark  | Parchment `#FAFAF6` | Saffron `#D4A017` |

For automatic mode-switching, use `pithy-wordmark.svg` (the adaptive file). For explicit single-mode placement, use `pithy-wordmark-light.svg` or `pithy-wordmark-dark.svg`.

### 2.6 Don'ts

- Don't change the period's color. Ever. It's the brand.
- Don't apply shadows, gradients, glows, outlines, or 3D effects.
- Don't rotate, skew, or distort the wordmark.
- Don't recolor the wordmark to anything other than ink (light mode) or parchment (dark mode).
- Don't add a tagline within the wordmark lockup.
- Don't use the wordmark on busy backgrounds or photography without an ink/parchment surface beneath.
- Don't put the wordmark inside a container (box, frame, circle) — let it breathe.
- Don't recreate the wordmark in another typeface.

---

## 3. Color

### 3.1 Primary palette

The three colors that define the brand.

| Token     | Hex       | RGB           | Use                                               |
| --------- | --------- | ------------- | ------------------------------------------------- |
| Ink       | `#111111` | 17, 17, 17    | Primary text in light mode; surfaces in dark mode |
| Parchment | `#FAFAF6` | 250, 250, 246 | Surfaces in light mode; primary text in dark mode |
| Saffron   | `#D4A017` | 212, 160, 23  | Accent — period, interactive states, highlights   |

### 3.2 Extended palette — light mode

| Token           | Hex                   | Use                                            |
| --------------- | --------------------- | ---------------------------------------------- |
| `bg`            | `#FAFAF6`             | Page background                                |
| `surface`       | `#FFFFFF`             | Elevated surface (cards, modals)               |
| `surface-muted` | `#F2F1EB`             | Recessed surface (code blocks, inputs)         |
| `fg`            | `#111111`             | Primary text                                   |
| `fg-muted`      | `#5F5D57`             | Secondary text                                 |
| `fg-subtle`     | `#9A988F`             | Tertiary text, hints                           |
| `border`        | `rgba(17,17,17,0.12)` | Default borders                                |
| `border-strong` | `rgba(17,17,17,0.24)` | Emphasized borders                             |
| `accent`        | `#D4A017`             | Saffron — links, period, interactive accent    |
| `accent-hover`  | `#B88912`             | Hovered accent state                           |
| `accent-muted`  | `#F5E7B8`             | Saffron tinted background (badges, highlights) |

### 3.3 Extended palette — dark mode

| Token           | Hex                      | Use                                              |
| --------------- | ------------------------ | ------------------------------------------------ |
| `bg`            | `#14110D`                | Page background                                  |
| `surface`       | `#1F1B16`                | Elevated surface (cards, modals)                 |
| `surface-muted` | `#2A251E`                | Recessed surface (code blocks, inputs)           |
| `fg`            | `#FAFAF6`                | Primary text                                     |
| `fg-muted`      | `#A09C90`                | Secondary text                                   |
| `fg-subtle`     | `#6B675E`                | Tertiary text, hints                             |
| `border`        | `rgba(250,250,246,0.10)` | Default borders                                  |
| `border-strong` | `rgba(250,250,246,0.22)` | Emphasized borders                               |
| `accent`        | `#D4A017`                | Saffron — unchanged                              |
| `accent-hover`  | `#E0AC1E`                | Hovered accent state (slightly brighter in dark) |
| `accent-muted`  | `#3D2E0A`                | Saffron tinted background                        |

### 3.4 Auto-switching CSS variables

Drop this into your global stylesheet. It defines the brand tokens as CSS variables and auto-swaps via `prefers-color-scheme`.

```css
:root {
  --color-bg: #FAFAF6;
  --color-surface: #FFFFFF;
  --color-surface-muted: #F2F1EB;
  --color-fg: #111111;
  --color-fg-muted: #5F5D57;
  --color-fg-subtle: #9A988F;
  --color-border: rgba(17, 17, 17, 0.12);
  --color-border-strong: rgba(17, 17, 17, 0.24);
  --color-accent: #D4A017;
  --color-accent-hover: #B88912;
  --color-accent-muted: #F5E7B8;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #14110D;
    --color-surface: #1F1B16;
    --color-surface-muted: #2A251E;
    --color-fg: #FAFAF6;
    --color-fg-muted: #A09C90;
    --color-fg-subtle: #6B675E;
    --color-border: rgba(250, 250, 246, 0.10);
    --color-border-strong: rgba(250, 250, 246, 0.22);
    --color-accent: #D4A017;
    --color-accent-hover: #E0AC1E;
    --color-accent-muted: #3D2E0A;
  }
}

html {
  background: var(--color-bg);
  color: var(--color-fg);
  color-scheme: light dark;
}
```

### 3.5 Tailwind v4 configuration

If you're on Tailwind v4, define brand tokens in your CSS using `@theme`:

```css
@import "tailwindcss";

@theme {
  --color-ink: #111111;
  --color-parchment: #FAFAF6;
  --color-saffron: #D4A017;

  /* Semantic tokens — reference CSS vars defined elsewhere */
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-surface-muted: var(--color-surface-muted);
  --color-fg: var(--color-fg);
  --color-fg-muted: var(--color-fg-muted);
  --color-fg-subtle: var(--color-fg-subtle);
  --color-border-default: var(--color-border);
  --color-border-strong: var(--color-border-strong);
  --color-accent: var(--color-accent);
  --color-accent-hover: var(--color-accent-hover);
  --color-accent-muted: var(--color-accent-muted);
}
```

Then in markup: `bg-bg text-fg border-border-default text-accent` etc.

### 3.6 Tailwind v3 configuration

If you're on Tailwind v3:

```js
// tailwind.config.js
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand constants
        ink: '#111111',
        parchment: '#FAFAF6',
        saffron: {
          DEFAULT: '#D4A017',
          hover: '#B88912',
          muted: '#F5E7B8',
        },
        // Semantic — reference CSS variables for auto light/dark
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        'surface-muted': 'var(--color-surface-muted)',
        fg: 'var(--color-fg)',
        'fg-muted': 'var(--color-fg-muted)',
        'fg-subtle': 'var(--color-fg-subtle)',
        'border-default': 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        accent: 'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        'accent-muted': 'var(--color-accent-muted)',
      },
      fontFamily: {
        sans: ['Geist', 'Geist Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
};
```

---

## 4. Typography

### 4.1 Sans — Geist Sans

Geist Sans (by Vercel) is the primary typeface. Free under the SIL Open Font License.

- **Source:** https://vercel.com/font, also on Google Fonts and npm (`geist`)
- **Weights to load:** 300 (Light), 400 (Regular), 500 (Medium), 600 (Semibold)
- **Wordmark weight:** 500 (Medium) — non-negotiable for the official mark
- **Body weight:** 400 (Regular)
- **Headings weight:** 500 (Medium) — never 600 or 700 in long-form contexts; 600 is acceptable for landing-page hero headlines only

### 4.2 Mono — Geist Mono

Geist Mono is the partner monospace, designed to sit alongside Geist Sans.

- **Source:** Same as Geist Sans (`geist/font/mono` in npm)
- **Weights to load:** 400 (Regular), 500 (Medium)
- **Use for:** code samples, CLI output, package names, technical labels, version numbers

### 4.3 Type scale

Modest hierarchy. The brand reads as edited, not loud.

| Token         | Size              | Line height | Weight     | Use                                                 |
| ------------- | ----------------- | ----------- | ---------- | --------------------------------------------------- |
| `display`     | 72px              | 1.05        | 500        | Landing hero only                                   |
| `h1`          | 48px              | 1.1         | 500        | Page title                                          |
| `h2`          | 32px              | 1.15        | 500        | Section heading                                     |
| `h3`          | 22px              | 1.25        | 500        | Subsection                                          |
| `h4`          | 18px              | 1.3         | 500        | Inline heading                                      |
| `body-lg`     | 18px              | 1.6         | 400        | Lede paragraph                                      |
| `body`        | 16px              | 1.65        | 400        | Default text                                        |
| `body-sm`     | 14px              | 1.6         | 400        | Secondary text, captions                            |
| `code-inline` | 0.92em (relative) | inherit     | 400 (mono) | Inline code                                         |
| `code-block`  | 14px              | 1.55        | 400 (mono) | Code blocks                                         |
| `label`       | 11px              | 1.4         | 500 (mono) | Section labels, eyebrows; tracking 0.12em uppercase |

### 4.4 Font loading

For Next.js / modern frameworks, use the official Geist npm package:

```ts
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

// In your root layout:
<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
```

For plain HTML, link from Google Fonts or self-host the OFL files from the Geist GitHub repo.

---

## 5. Voice & tone

The voice is the visual identity in language form.

**Principles:**

1. **Sentence length signals position.** Short sentences. Period emphasis. Use rhythm.
2. **Lower-case is fine.** Sentence case is the default. Title Case is for legal copy. ALL CAPS is for nothing.
3. **Confidence without performance.** State what's true. Don't oversell.
4. **Technical without jargon-stuffing.** Pick the right word, not five almost-right words.
5. **No "amazing." No "delightful." No "best-in-class."** Boring marketing language betrays the brand.

**Sample copy:**

- Headline: `A backend kit. For Cloudflare. That's it.`
- Subhead: `Auth, storage, vector, leaderboard, jobs. Open source. Composable. Stays out of your way.`
- CTA primary: `Get started` (not "Get started for free!")
- CTA secondary: `Read the docs`
- Empty state: `Nothing here yet.`
- Error: `That didn't work. Here's why:` (then the specific reason)
- Success: `Done.`

**The period as rhythm device:** Sentences ending in deliberate periods, often in three-beat patterns, are a signature voice convention. Use sparingly — overusing it makes the brand sound smug.

---

## 6. Application examples

### 6.1 CLI output

The CLI inherits the brand colors. Use Geist Mono if rendering in a context that supports it (terminals don't, but log files, web terminals, and docs do).

```
$ pithy add auth

▸ Installing @pithy-sh/auth...
▸ Updating wrangler.jsonc...
▸ Running migration: auth_0001_create_users...

Done.
```

- Status arrows (`▸`) in ink (or default terminal foreground)
- Step labels in `fg-muted`
- Final `Done.` with the period in saffron (256-color terminal) or just plain (basic terminals)
- Errors use a red accent (`#E24B4A`) sparingly; success uses saffron, not green

### 6.2 Docs site layout

- Background: `bg`
- Generous left margin on body content (think editorial book layout)
- Code blocks: `surface-muted` background, 14px Geist Mono, no syntax theme on small inline code
- Sidebar nav: `body-sm` font, `fg-muted` color, current item in `fg`
- Section labels: `label` token (11px Geist Mono, uppercase, 0.12em tracking, `fg-subtle`)
- Pull quotes (when needed): `body-lg`, italic if you're using a serif accent, otherwise just larger; saffron period at the end of the quote serves as the attribution mark

### 6.3 Web page header

- Pithy wordmark left-aligned, 32px tall, with full clear space
- Nav items in `fg-muted` at `body` size, current page in `fg`
- No drop shadow on the header; instead a 0.5px `border` line at the bottom

### 6.4 npm package descriptions

Keep them pithy. Verbatim style:

> A backend kit for Cloudflare Workers. Auth, storage, vector search, leaderboard, jobs. Composable. Opinionated. Open source.

---

## 7. Asset files

Source-of-truth assets live in **`docs/assets/brand/`** (paths below are relative to that
directory). The docs site and any deploy target import/serve from there.

| File                       | Use                                                                      |
| -------------------------- | ------------------------------------------------------------------------ |
| `pithy-wordmark.svg`       | Adaptive wordmark — auto-swaps text color via `prefers-color-scheme`     |
| `pithy-wordmark-light.svg` | Wordmark for light backgrounds (ink text)                                |
| `pithy-wordmark-dark.svg`  | Wordmark for dark backgrounds (parchment text)                           |
| `pithy-favicon.svg`        | Adaptive favicon — rounded square background swaps; saffron period stays |
| `pithy-social.svg`         | Social / "p." avatar mark (adaptive) — ink bg, parchment p, saffron period |
| `pithy-social-light.svg`   | Social / "p." avatar mark — light (parchment) background                 |

### Favicon HTML

```html
<link rel="icon" type="image/svg+xml" href="/pithy-favicon.svg">
<link rel="icon" type="image/png" href="/pithy-favicon-32.png" sizes="32x32">
<link rel="icon" type="image/png" href="/pithy-favicon-16.png" sizes="16x16">
<link rel="apple-touch-icon" href="/pithy-apple-touch-icon.png">
```

Convert the SVG favicon to PNG at 16, 32, and 180 (apple-touch) sizes using a tool like `sharp` or `svgo` + `librsvg`. The SVG handles modern browsers; PNGs cover legacy and platforms that don't render SVG favicons.

### Production note on the wordmark SVGs

The wordmark SVGs use `<text>` with the Geist Sans font family and system fallbacks. This means:

- **In contexts where Geist Sans is loaded** (your website, embedded inline) the wordmark renders correctly.
- **In contexts where Geist Sans is not available** (some image viewers, third-party platforms) the wordmark falls back to a system sans, which will look slightly off.

For production-critical contexts (press kits, third-party embeds, print), convert the wordmark to vector paths using Figma, Illustrator, or `svgo --enable=convertShapeToPath`. Store the path-converted version separately as `pithy-wordmark-paths.svg`.

---

## 8. Quick reference

```
Color
  Ink         #111111
  Parchment   #FAFAF6
  Saffron     #D4A017 (always — never change)

Type
  Sans        Geist Sans
  Mono        Geist Mono
  Wordmark    Medium (500), -0.05em tracking

Logo
  Clear space   = x-height
  Min size      80px screen / 1in print
  Mark min      16px

Voice
  Short sentences. Confident. No fluff. The period earns its keep.
```

---

## 9. Official handles, domains & orgs

The canonical identity. Use these exactly; do not invent variants.

| Channel          | Handle / URL                         | Notes                                                                      |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| Primary domain   | **pithy.sh**                         | The home. All canonical links and the brand name resolve here.             |
| Redirect domains | pithysh.com, pithy-sh.com, pithy.run | All 301 → `pithy.sh`. Never used as canonical links.                       |
| npm org          | **`@pithy-sh`**                      | The bare `pithy` scope was taken, so packages publish under `@pithy-sh/*`. |
| GitHub org       | **github.com/pithy-sh**              | Source + issues + releases.                                                |
| Bluesky          | **@pithy.sh**                        | Matches the domain (Bluesky allows the dot). Preferred social handle.      |
| X (Twitter)      | **@pithy_sh**                        | X disallows `.` and `-` in handles, so the dot becomes an underscore.      |

**The dot rule across handles.** The brand is the period, so prefer the dotted form
(`pithy.sh`, `@pithy.sh`) wherever a platform allows it. Where the dot is disallowed (npm,
X), fall back to the hyphen or underscore form — but the dotted form is the canonical one.
