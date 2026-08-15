# Front ends: `pithy ui`

One command puts a React 19 front end inside a Worker you already have, and wires it end to end. The SPA and the API build together, deploy together, and answer on one origin. No second project, no CORS, no second deploy.

```bash
pithy ui add react --worker api
```

## What it does

It scaffolds the client into `apps/api/`, beside the Worker that serves it, and edits three files to connect them.

- **Writes the client.** A Vite entry document, a Vite config wired with the Cloudflare and React plugins, two tsconfigs, ambient types, an SPA entry, a router, styles, the one module that narrows every capability's client projection, Pithy's sign-in screens when the Worker composes `auth`, its paywall, pricing and subscription screens when it composes `payments`, and one screen of your own.
- **Wires the asset routing.** An `assets` stanza in `wrangler.jsonc`: SPA fallback for anything the browser asks for, and an explicit allowlist of the API paths the Worker must answer itself.
- **Joins the dev set.** A `dev` block in `pithy.worker.jsonc` so `pithy dev` runs Vite for this Worker instead of `wrangler dev` — one process serving the SPA and the API together.
- **Records the build.** A `ui` block so `pithy deploy` builds the client before shipping the Worker.
- **Adds the dependencies.** React, Vite, the two plugins, and `@pithy-sh/vite`, at pinned versions. A `@pithy-sh/*` package your project already provides from a linked checkout gets no range written — there is no published version to name, and writing one breaks your next install.

## What it does not do

- It does not create a Worker. `pithy ui add` scaffolds into one that exists; `pithy worker add` makes new ones.
- It does not touch `src/index.ts`. Your Worker entry is untouched, before and after.
- It does not overwrite anything. Ever. See [Ownership](#ownership).
- It does not generate a client SDK, a types file, or any other build artifact to disk. What the client knows about your backend comes from virtual modules resolved in memory. See [`virtual:pithy/<capability>`](#virtualpithycapability).
- It does not take provider flags. Which social providers you offer lives in `pithy.config.ts` and nowhere else. See [Social providers](#social-providers).
- It does not scaffold a mobile client. Bearer auth is fully supported and documented below; it is simply not what this stub is.

## The layout

Everything lives in the Worker's own directory. New files are marked; the rest was already there.

```
apps/api/
  index.html                 new   Vite entry document
  vite.config.ts             new   cloudflare() + react() + pithy()
  tsconfig.client.json       new   jsx + DOM; covers src/**/*.tsx and client-env.d.ts
  tsconfig.node.json         new   types: ["node"]; covers vite.config.ts
  client-env.d.ts            new   ambient declarations for virtual:pithy/*
  src/
    index.ts                       the Worker entry — untouched
    client.tsx               new   SPA entry: mounts the router
    router.tsx               new   the two-glob router and its route guard
    styles.css               new   yours: the palette tokens, the reset, body
    pithy-screens.css        new   Pithy's: every class Pithy's own screens render
    pithy-config.tsx         new   the one module that imports virtual:pithy/*
    session.tsx              new   --auth  session hook, signOut, signed-in guard
    turnstile.tsx            new   --auth  the widget and its token placement
    payments.tsx             new   --payments  the client bound to the base path, and the guard's data
    routes/
      pithy/sign-in.tsx      new   --auth  and otp.tsx, callback.tsx — Pithy's screens
      pithy/paywall.tsx      new   --payments  and pricing.tsx, subscription.tsx
      app/home.tsx           new   yours, written once and never again
  wrangler.jsonc             edited  assets stanza
  pithy.worker.jsonc         edited  dev block + ui block
  package.json               edited  dependencies + scripts
  tsconfig.json                      the Worker's own program — untouched

../../tsconfig.json          edited  the project's solution file: + the two programs above
```

**Both client tsconfigs are `composite`, and both are referenced.** The project's root `tsconfig.json` is a solution file — `"files": []` and a list of `references` that `tsc -b` walks — and `pithy ui add` appends the client's two programs to it. Left unreferenced they compile for nobody: `bun run typecheck` would cover the Worker and none of the client beside it. `composite` is what a reference costs, and it makes tsc write a `.tsbuildinfo`; each names one under the **project's** `dist/`, never `apps/<worker>/dist`, which Vite empties on every build.

**Why `client-env.d.ts` sits at the Worker root and not under `src/`.** The Worker's `tsconfig.json` includes `src/**/*.ts`. That glob does not match `.tsx`, so every client file being `.tsx` is what keeps the client out of the Worker's type program — no edit to the Worker's tsconfig, no DOM types leaking into Workers code. A `.d.ts` under `src/` *would* match, so the ambient declarations live one level up.

The rule that keeps this true: **no `.ts` file in the Worker program may import a `.tsx` file.** The seam is runtime-only. Cross it with an import and the browser build joins the Worker's type program.

## Ownership

Pithy writes a file **once**, and from that moment the file is yours.

- `pithy ui add` creates a file only if it does not exist. An existing file is left byte-for-byte alone and reported as kept.
- Nothing is regenerated, reformatted, merged, or patched on any later run.
- A future release may add a *new* stub file — one that does not exist in your project yet. It may never rewrite one that does.
- `src/routes/app/` is written exactly once, at the initial scaffold, and never written again. It is your application. Pithy has no business in it.

The practical upshot: edit anything. Delete `src/routes/pithy/sign-in.tsx` and write your own. Rewrite `styles.css` from scratch. Nothing upstream will argue with you, and nothing will silently revert.

### Two stylesheets, and why

`src/styles.css` is yours: the palette tokens, the reset, `body`. `src/pithy-screens.css` is Pithy's, and it defines **every class name a Pithy screen renders** — `screen`, `muted`, `stack`, `secondary`, `otp`, `divider`, and the `auth*` rules that lay out the sign-in page. Pithy's screens import it themselves.

They are two files because ownership says they must be. Adding the sign-in screens to a project that already has a stylesheet — `pithy add auth`, then `pithy ui add react --auth` — writes the screens and correctly skips `styles.css`, because that file is yours. When one file held both, that run produced a sign-in screen whose classes nothing defined and reported it as created. A screen and the rules it needs are one artifact; splitting them by ownership is what lets each be written on its own schedule.

Two properties make Pithy's file safe to keep:

- **Everything in it sits in a `@layer pithy` cascade layer.** Unlayered CSS beats layered CSS regardless of order or specificity, so any rule you write wins over one of Pithy's with no `!important` and no regard for import order. Give `.screen` a different `max-width` in your own stylesheet and it takes.
- **Its palette is seven tokens read with fallbacks** — `--bg`, `--surface`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--danger`. Declare them on `:root` and Pithy's screens adopt your colours; declare none and they stand up on their own, following `prefers-color-scheme`. **Declare them as a set**: a screen whose background is yours and whose text is Pithy's is the one way this can still read badly, and no fallback can detect it.

`pithy ui add` checks the result rather than assuming it. After writing, it reads the stylesheets actually on disk and names any class the screens render that none of them defines — under `--json` as `unstyled`. Empty is the ordinary answer; anything else is the exact list to fix.

### Where the templates live

The screens are real files in **`@pithy-sh/ui-react`**, a template library the CLI depends on and copies from — not string literals inside `@pithy-sh/cli`.

That is a deliberate boundary, and it is about growth. A framework's templates need that framework's toolchain to be checked: React wants `react`, `@types/react` and a `jsx: react-jsx` program, and Svelte would want an entirely different one. Keeping them in the CLI would make the CLI carry every framework's devDependencies and every framework's tsconfig purely to typecheck files it only ever copies. Each framework therefore brings its own library — `@pithy-sh/ui-react` today, `@pithy-sh/ui-<framework>` as others land — while the stub contract that drives them stays in the CLI.

It also means the screens are ordinary source: `tsc` typechecks them and Biome lints them, in the layout they will have once copied. A template that does not compile fails CI here, rather than in your project.

The tree mirrors the scaffolded layout one-to-one, and which files a given invocation writes is chosen by a named group in the library's manifest rather than by directory. `base` is written always; `auth` rides on the auth capability, and `payments` on the payments one. The groups stack rather than choose — a Worker composing both gets both screen sets, because they name disjoint files over one layout. That is what a later screen set costs too: a new group naming new files in the same tree, with no path moved, no import changed, and no change to the stub contract.

## Routing

The router is two `import.meta.glob` calls and a shadow rule.

```
src/routes/pithy/*.tsx     Pithy's screens
src/routes/app/*.tsx       yours
```

Each route module exports its own `path` alongside its component. The router reads both globs, keys the modules by their declared `path`, and lets `app/` **shadow** `pithy/`: a module in `app/` that declares the same `path` as one in `pithy/` replaces it entirely.

Two consequences worth stating plainly.

**Adding a screen needs no edit and no re-run.** Drop `src/routes/app/settings.tsx` into place with `export const path = "/settings"`, and it is routed. There is no route table to register in, no generated manifest, no `pithy ui` command to run again.

**Replacing a Pithy screen needs no fork.** Write `src/routes/app/sign-in.tsx` with `export const path = "/sign-in"` and yours wins. Pithy's file stays on disk, unmodified and inert — delete it whenever you like.

**A test beside a screen is still just a test.** Co-locate `home.test.tsx` next to `home.tsx`, as the kit asks you to everywhere else. Both globs negate `*.test.tsx` and `*.spec.tsx` — the test runner's own names for its own files — so a co-located test is registered as nothing and reaches no bundle. That negation is the one filename rule the router has, and it earns its place: without it the file is a route, and everything in it — fixtures, stub tokens, the shape of an endpoint and how it fails — is served to anyone who asks. A companion file under another tool's convention, a `.stories.tsx` say, is not covered; give it its own negation, or keep it outside `src/routes/`.

### Path parameters

A segment beginning `:` is a parameter, and its value arrives as a typed `params` prop.

```tsx
import type { ScreenProps } from "../../router";

export const path = "/invitations/:token";

export default function Invitation({ params }: ScreenProps<typeof path>) {
  return <p>Accepting {params.token}.</p>;
}
```

`ScreenProps<typeof path>` is what makes the names real: `params.token` is a `string`, and `params.tokne` does not compile. That works because `path` is a `const` string literal, which is how every screen already declares it — read the names off the pattern and there is no second place to keep them in step.

Identifier-in-path is the ordinary shape for anything arriving by link: an invitation, a password reset, a shared record, an unsubscribe confirmation. Four rules, all of them decided rather than emergent.

**A static segment beats a dynamic one, at the leftmost segment where two patterns differ in kind.** `/invitations/new` answers `/invitations/new`; `/invitations/:token` answers everything else in that position. The winner is chosen by comparing patterns, not by which glob reached a file first, so it is the same on every machine and after every rename. Two patterns of identical shape — `/a/:x` and `/a/:y` — are one route written twice; the router picks the same one every time, but it cannot pick the one you meant.

**Values are decoded once, in the router.** No screen calls `decodeURIComponent`. The path is split on `/` before decoding, so `%2F` is a slash *inside* a value rather than a segment boundary, and an id containing a slash survives the round trip. A segment whose encoding is malformed — `%zz` — does not match, and the visitor gets the not-found screen rather than a screen holding something nobody sent.

**A parameter captures at least one character.** `/invitations/` does not match `/invitations/:token`. An empty token is not a token.

**One level, and no more.** A pattern matches a path with the same number of segments. There are no wildcards, no optional segments, no nested routes and no layouts — `/a` does not answer `/a/b`. Nesting is a different and much larger request; this is the piece that was missing.

**Prefer a path over a query string for anything link-addressed.** A query string lands in referrer headers and access logs more readily than a path segment. It is not a large difference — a token in a URL is a token in a URL — but it is the wrong thing to be forced into. Pithy's own `/otp` screen keeps its `?email=`, and says why in the file: that URL points at the code-entry screen, the address is a prefill rather than the resource, and `/otp` with no email is a valid screen.

## `virtual:pithy/<capability>`

Your screens need to know things about the backend: which social providers are enabled, whether a Turnstile widget must render and with which public sitekey, what the auth base path is. That knowledge lives in `pithy.config.ts`, which is server-side. The bridge is a set of virtual modules served by the `pithy()` Vite plugin in `@pithy-sh/vite`.

```tsx
import auth from "virtual:pithy/auth";

if (auth.enabled) {
  // render the providers this project actually declares
}
```

The exact shape of each projection is declared in `client-env.d.ts`, which is where to look rather than guess.

**Import the default and narrow on `enabled`. Do not import a projection key by name.** A capability that is not composed projects `{ enabled: false }` and nothing else, so `import { sitekey } from "virtual:pithy/turnstile"` is a missing export — and the build fails on precisely the case the mechanism exists to survive. Each module's declared type is a union discriminated on `enabled`, so narrowing is what makes the other fields visible, and TypeScript will not let you read one without it.

The scaffold does this in exactly one place. `src/pithy-config.tsx` imports each virtual module, narrows it once, and re-exports `authConfig`, `turnstileConfig` and `paymentsConfig`; every screen reads those. It is written by every scaffold, not by a capability's own group, precisely because it belongs to all of them. If you add a screen of your own, read it from there too — or import the virtual module directly and narrow it yourself. Either is fine; a bare named import is not.

Four things make this work the way it does.

**Each capability declares its own client-safe projection.** The capability decides what a browser may know — public sitekeys, base paths, enabled flags — and nothing else crosses. A secret cannot leak through a projection that never names it, and the decision sits in the capability that owns the data rather than in a scaffolding template that has to be kept honest by review.

**An uncomposed capability resolves to `{ enabled: false }`.** Import `virtual:pithy/turnstile` in a project that does not compose turnstile and you get a well-typed object saying so. So screens **branch**, they do not guard: no `try`/`catch` around an import, no optional chaining through three levels, no build error for asking about something you do not have.

**Nothing is generated to disk.** No `pithy-client.ts`, no `.generated/` folder, no file to gitignore, commit, or find stale. The plugin resolves the module in memory from the composed config at dev-server start and at build. There is no artifact to drift because there is no artifact.

**The types are ambient.** `client-env.d.ts` declares the `virtual:pithy/*` modules for the client tsconfig, which is why the import above type-checks with no path mapping.

## The sign-in screen

It is the first screen anyone sees, so it is scaffolded finished rather than bare.

**Two columns, and one of them is yours.** `src/routes/pithy/sign-in.tsx` opens with two constants:

```tsx
const BRAND: ReactNode = null;   // the panel beside the form
const MARK: ReactNode = null;    // the compact mark, for the widths the panel is not on
```

`BRAND` is the panel — your mark, your sentence, your claims. It ships empty, and the layout is correct empty: with nothing there the page is one centred column rather than a blank half. Fill it and the page becomes the two-column split. `MARK` appears in the form column at the widths where the panel is not rendered, so exactly one of the two is ever on screen.

**The panel is not stacked below the form at a narrow width — it is not rendered.** Copy under a sign-in form is copy nobody reads with a keyboard open, and it pushes the thing you came to do off the screen.

**One way in: the magic link.** Two passwordless paths on one screen is two things to explain, two surfaces to rate-limit, and two inboxes' worth of mail for one intent. `routes/pithy/otp.tsx` is still written, and nothing routes to it — send a code from your own screen if you would rather have that flow.

**A provider that cannot complete does not pretend it can.** The client projection carries booleans, never credentials, so a browser cannot tell an enabled provider from a configured one. The screen refuses the *response* instead: an authorization URL with no `client_id` is a provider switched on with a blank credential behind it, and it produces a sentence on the screen rather than a bounce to Google's own error page. A non-http(s) URL is refused on the same path, because `window.location.href = url` with a `javascript:` URL runs that script in your page.

**"No account yet? Signing in creates one." is a statement, not a link.** Passwordless has no sign-up screen to point at, so an anchor there would be a 404 dressed as an affordance. Do not style it as one.

### The provider marks, and the terms they ship under

Every provider the screen can render arrives with its logo: Google, GitHub, Apple, Facebook. **They are trademarks, not icons, and none of them is covered by Pithy's MIT licence.** Each mark is a component of its own with its owner's rules in the doc comment above it, and that is deliberate — the rules are opposite from one provider to the next, so one parameterised `<Mark provider="…" />` would have to encode "unless it is Google" somewhere and the first tidy-up would lose it.

The short version, with the long version beside the asset:

| Mark | Colour | Why |
| --- | --- | --- |
| GitHub | `currentColor` | The monochrome Invertocat is the form GitHub publishes; it follows your theme for free. |
| Google | four fixed hex fills | Google's terms forbid recolouring the mark. It answers no theme and no token. |
| Apple | `currentColor` | Apple permits black or white only — which is what `--pithy-fg` resolves to. Change `--fg` to anything else and you must override it. |
| Facebook | fixed `#1877F2` on a white disc | Meta fixes the colour, and the published path cuts the "f" out, so the disc is what keeps the counter white in both themes. |

Two rules if you add a provider:

- **Never hand-draw a mark.** A wrong-shaped official logo on a credentials page is what a phishing page looks like. If you cannot source accurate path data, ship that button with no mark — label-only buttons render correctly.
- **Font Awesome's `brands/google` is a monochrome single-path G.** It is the obvious thing to reach for, it is in the package most projects already have, and it is the wrong asset for a sign-in button: Google's guidelines require the four-colour mark there. The same goes for any other icon set's "google" glyph.

Apple and Google additionally specify the *button*, not only the mark — background, corner radius, minimum size, wording. Pithy's `.auth__provider` is a generic secondary button and makes no claim to satisfy either. Read their guidelines before you enable those providers in production.

## Social providers

Enabling Google is a one-line edit in `apps/api/pithy.config.ts`:

```ts
auth({ /* … */ google: { enabled: true } })
```

Then store the credentials as the `auth-google-credentials` secret and redeploy. That is the whole procedure. **There is no CLI flag** — not on `pithy ui add`, not anywhere — because a flag would freeze the provider list into scaffolded code at the moment you ran the command, and it would be wrong the first time you changed your mind. The sign-in screen reads `virtual:pithy/auth` and renders the providers your config actually declares, so config is the only source of truth and a redeploy is the only step.

## Turnstile

Turnstile is correctness here, not polish.

When your project composes `@pithy-sh/turnstile`, `@pithy-sh/auth` automatically gates its magic-link and OTP send routes with the humanity check — no wiring, no opt-in. A sign-in form that does not render the widget therefore **cannot sign anyone in**: the request arrives without a token and is refused. This is why the widget is part of the scaffolded screen rather than something to add later.

Two boundaries the stub respects:

- The widget renders on the **magic-link and OTP form only** — the surfaces the middleware actually gates.
- **Social sign-in is never gated.** The provider runs its own bot defense, and the OAuth redirect flow carries no token to check.

**And it is sized in two places, not one.** Turnstile draws itself in a cross-origin iframe with an intrinsic size, so `width: 100%` on the host does nothing by itself: `turnstile.tsx` asks the widget for its `flexible` size, and `pithy-screens.css` keeps the column it lands in above the 300px that size stops shrinking at. Both halves are required — either alone leaves a widget that does not line up with the field above it. The stylesheet names Cloudflare's floor once, as `--pithy-check-min`, and derives the form's measure and gutter from it; `@pithy-sh/ui-react`'s `humanityCheckFit.test.ts` fails if either derivation is replaced by a number.

The public sitekey reaches the screen through `virtual:pithy/turnstile`, per environment. Sitekeys are public by design; the widget secret is never in config and never in the client — it lives in `@pithy-sh/secrets`.

**The `action` reaches it the same way, and must not be retyped.** Turnstile bakes an action label into the token at render and echoes it from siteverify; the sign-in route asserts it. So `turnstile.tsx` renders `turnstileConfig.action` rather than a string of its own — the projection is the one statement, and `@pithy-sh/turnstile`'s `TURNSTILE_LOGIN_ACTION` is where it is made. Writing the label out again anywhere is a defect nothing short of production can find: dev and staging run Cloudflare's always-pass test key, whose answer carries **no action at all**, so a drifted copy is silent in both, and the first environment that can tell is the one where the mismatch refuses every sign-in. Two gates hold it — `@pithy-sh/ui-react`'s `turnstileAction.test.tsx` (the widget carries what it is handed) and `@pithy-sh/auth`'s `turnstileActionBinding.test.ts` (the route asserts what is handed).

## Paywalls, and where the purchase flow lives

The payments screens are the one place the stub deliberately owns less than it looks like it does.

`pithy ui add` writes a file once and may never rewrite it. That is the right ownership rule, and it is exactly why a frozen paywall ages badly: store rules move under it. Price-change consent prompts, external purchase link entitlements, subscription-management requirements — each arrives after the file was written, and a purchase flow sitting in your repo is one Pithy cannot fix for you.

So the surface splits by what changes. **`@pithy-sh/payments` exports the hooks** — `useEntitlement`, `usePurchase`, `useSubscription`, `useCheckout`, `usePaddleCheckout`, `usePaddle`, `usePricePreview`, from `@pithy-sh/payments/src/client/hooks` — and owns the calls, the redirect-and-return dance, the error mapping, the entitlement reads, and opening a Paddle overlay or inline frame at the moment its container exists. They upgrade with a minor release. **The scaffolded screen renders and styles**, calling those hooks rather than reimplementing them. The screens are still yours to rewrite; what you inherit for free is the part that goes stale.

`src/payments.tsx` is the thin bridge: it binds every call to this project's own base path, and answers the router's entitlement guard.

### The web scaffold sells on one rail

StoreKit and Play Billing need native app code to present a purchase sheet, and `pithy ui add` does not scaffold a mobile client. So the paywall lists every product and offers a buy button only for the ones Stripe sells; the rest read "available in the app."

| Stub | Apple | Google | Stripe |
|---|---|---|---|
| Paywall / product picker | Display only | Display only | Purchasable |
| Subscription status | Yes | Yes | Yes |
| Manage subscription | Store deep link | Store deep link | Billing Portal |
| Restore purchases | Native only — absent from web | Native only — absent from web | Not applicable |
| Entitlement route guard | Yes | Yes | Yes |

Hosted Checkout needs no SDK script and no publishable key in the page: the server mints a session, the client follows one URL, and Stripe owns everything in between. The store deep links live in the package rather than in the template, so a store moving one is a minor release.

### The entitlement route guard

A route module gates itself the way it declares a session — one export:

```tsx
export const path = "/reports";
export const entitlement = "pro";
```

An entitlement belongs to somebody, so declaring one implies the session guard: the same order the server states it in, `requireAuth()` then `requireEntitlement()`.

**It is a UX affordance, never a security boundary.** The server check is the boundary — every paid route declares `requireEntitlement()`, and no answer in the browser changes that. The guard exists so a visitor without `pro` lands on the paywall instead of watching a screen fill with 403s. Its failure direction follows from that: with payments not composed at all, the guard renders rather than blocks, exactly as the session guard does with no auth capability.

## Web auth: cookies, one origin, CSRF

The scaffolded client uses **cookie sessions**, and it can because the SPA and the API share an origin. The browser sends the session cookie on same-origin requests with no header work, no token juggling, and no refresh logic in your UI.

Cookie mode means CSRF protection, always, and Pithy's is `requireSameOrigin()` from `@pithy-sh/core`: every mutating route checks the request's origin against the auth config's `baseURL` and `trustedOrigins`. Same-origin deployment is what makes that check both strict and invisible.

**In `dev`, "same origin" is the address the run is actually serving on.** `baseURL` holds where you deploy, and where you deploy is HTTPS; local dev has no TLS and its port is assigned per Worker per run, so it is the one address no config file can hold. A `dev` composition therefore ignores `baseURL` and resolves `http://<the host the request arrived at>` — which is what the browser is at, so the check passes with nothing added to `trustedOrigins`, and follows the port when a second Worker shifts the allocation. It is not a wildcard: a request whose `Origin` is a neighbouring worker in the same `pithy dev` run is refused like any other. The gate is one condition on the environment alone, so staging and production resolve `baseURL` verbatim and the same-origin set they build is unchanged.

The session cookie's name comes off the same resolution. Better Auth prefixes it `__Secure-` when the base URL is HTTPS, so a dev composition reads the unprefixed name — the name `pithy seed` writes. Both are computed from one place; they cannot disagree.

**Your own routes wear the same gate, and it takes no arguments.** `@pithy-sh/auth` publishes the check already bound to the origins it resolved, so `requireSameOrigin()` on a route of yours is the policy auth is enforcing — not a second copy of it that can drift. There is no origin list to pass, which is why there is no wrong one.

**No token is ever put in `localStorage`.** Not the access token, not the refresh token, not a copy "just for convenience". A token in `localStorage` is readable by any script that ends up on the page, and the whole point of the cookie path is that the credential is not reachable from JavaScript at all.

**Bearer stays the mobile path.** Short-lived access tokens with rotated refresh tokens in secure device storage, `Authorization: Bearer` on every call, PKCE and deep links for OAuth. It is fully supported by the same auth capability, on the same routes, and it is documented rather than scaffolded — this stub is a browser app, and in a browser, cookies are the right answer.

## Dev

`pithy dev` starts the whole project. A Worker with a UI contributes **one** process, not two:

- **One Vite process** runs the SPA and the Worker together, through `@cloudflare/vite-plugin`. Your React components hot-reload; your Worker code runs in workerd, in the same server, at the same address.
- **One pinned port.** The `dev.command` in `pithy.worker.jsonc` carries a `{port}` token that `pithy dev` substitutes with the port this feature reserved for this worker. `--strictPort` is passed so Vite fails loudly rather than drifting to the next free port — a worker that quietly moves breaks every sibling that was told its address ahead of time. `--configLoader runner` is passed for a different reason: it is what lets Vite load a `vite.config.ts` whose plugins are raw TypeScript, which every `@pithy-sh/*` package is. Run `vite` by hand without it and the config fails to load.
- **HMR against real bindings.** Not mocks. Your Worker talks to real Miniflare-backed D1 and KV while the client hot-reloads in front of it.
- **Shared Miniflare state at the project root.** The plugin's state path is set to `../../.wrangler/state`, which is the same store `pithy dev`, `pithy migrate`, and `pithy seed` already use. Migrate on one side and the running dev server sees it. Two Workers that declare the same `DB` binding share one database, exactly as they will in production.

Open the printed URL and both halves are there: `/` is the SPA, `/health` and `/auth/*` are the Worker.

## Production

Two steps, one origin.

```bash
pithy deploy --env production
```

Under the hood, for a Worker carrying a `ui` block: run `ui.build` (`vite build --configLoader runner`), then `wrangler deploy`.

- `vite build` emits the client to `dist/client/**` and the built Worker to `dist/<env_name>/{index.js,wrangler.json}`, where `<env_name>` is your wrangler `name` with dashes replaced by underscores (`acme-api` → `acme_api`).
- It also writes `.wrangler/deploy/config.json`, which redirects a subsequent plain `wrangler deploy` to that built config. No `-c` flag, no path to remember.
- `wrangler deploy` runs with the Worker directory as its working directory. From a workspace root, wrangler aborts with a workspace-detection error; `pithy deploy` already runs it in the right place.

The result is one Worker, one deployment, one origin: static assets served from Cloudflare's edge, API paths served by your code, no CORS preflight anywhere in the picture.

## The `run_worker_first` allowlist

This is the one piece worth understanding before you edit `wrangler.jsonc` by hand.

Cloudflare's asset router runs **before** your Worker. With `not_found_handling: "single-page-application"`, a path with no matching asset is answered with `index.html` — and the Worker is never invoked. That is exactly right for `/settings` and exactly wrong for `/health`. `run_worker_first` is the list of paths that skip the asset router and go straight to the Worker.

So `pithy ui add` writes an **explicit allowlist derived from that Worker's real composed route table**. Not `true`, and not a convention like `/api/*` — Pithy's routes sit at capability base paths (`/auth`, `/leaderboard`, `/ledger`, `/media`, `/matchmaking`, `/payments`, `/rating`, `/multiplayer`, `/storage`, `/vector`, `/_pithy/email`) plus `/health`, and nothing lives under `/api`. An allowlist that assumed otherwise would return the SPA shell for `GET /health` and reject `POST /auth/sign-in/magic-link` with a 405.

Three rules the derivation follows:

- **Both forms, every time.** `"/auth/*"` does not match a bare `"/auth"`, so each base path is emitted as the pair `"/auth"` and `"/auth/*"`.
- **Never a bare-prefix glob.** `"/media*"` would also capture `/mediafoo`. The pair `"/media"` + `"/media/*"` captures the route table and nothing beyond it.
- **Every environment, not just this one.** A Worker has one route table *per environment*, so the list is the union across every environment the project declares plus `dev`.

### Why every environment

A capability may decide at registration whether to mount a route at all. `@pithy-sh/auth` does: `/__pithy/dev-login` exists only in a `dev` composition, because it mints a session with no credential presented and has no business in a route table that ships.

Compose the Worker once — under whatever environment the command happens to be run in — and you get the route table of *that* environment while calling it the Worker's. That is how `/__pithy/dev-login` was left off every generated allowlist: `pithy ui sync` was not a `dev` composition, so the route did not exist to be found, and `--check` reported `every route reaches the worker` while `pithy dev`'s sign-in URL landed on the SPA's 404.

So the derivation assembles the Worker once per environment and takes the union. Anything conditionally mounted — on the environment, on a flag, on a capability being composed — is covered without you naming a path. `CI` is deliberately ignored while deriving: `--check` runs in CI and `sync` runs on a laptop, and a list that differed between them could never be checked. An entry nothing serves costs a 404 from the Worker; a missing one costs a 200 with the wrong body.

`dev` is never declared in `environments` — it is local and always present — so the derivation adds it itself.

### It is derived once, and every route you mount afterwards is yours to re-derive

This is the sharp edge, and it has cut. The list is written at `pithy ui add`, from the route table as it stood that day. Every route mounted after it — by `pithy add <capability>`, and by **you, writing a route into your own app capability** — is outside the list until something re-derives it. A route outside the list is answered by the SPA shell: `200`, `text/html`, and your handler never ran. Not a 404, not a 500. The wrong body with the right status.

Nothing in your test suite catches that. Tests call handlers directly; the asset router is not in the picture. So the check is a command, and it belongs in CI:

```bash
pithy ui sync --check --worker api     # writes nothing, exits 1 on a shadowed route
pithy ui sync --worker api             # re-derives and rewrites that one key
```

```
$ pithy ui sync --check --worker api
api: the SPA shell is answering these, not the worker.
  /api/cli/device/start
  /api/organisations
Run pithy ui sync --worker api.
```

`pithy ui sync` creates no files and regenerates no screens. Run it after any `pithy add` or `pithy remove`, and after you mount a route of your own.

**One key** is literal. `not_found_handling` is written once, when `pithy ui add` finds no `assets` stanza, and from then on it is yours like any other file Pithy authored — `sync` reads it and reports it, and never rewrites it. If you set it to something other than `single-page-application`, client-side deep links stop being served the app shell and reach your Worker instead, where Hono 404s them; `sync` will tell you what the value is, not argue with it.

### Why there is a list at all

The obvious repair for a list that goes stale is to delete it. Try it and the API comes back to life: `curl /api/organisations` reaches the Worker, and deep links still serve the app shell. It looks free. It is not, and the reason is one line in Cloudflare's asset worker:

```js
if (!(has_static_routing || (navigateFlag && request.headers.get("Sec-Fetch-Mode") === "navigate")))
  configuration = { ...configuration, not_found_handling: "none" };
```

An array `run_worker_first` is what sets `has_static_routing`. With it, a path the list misses gets the shell whatever the method — the failure above. Without it, every **non**-navigation falls through to the Worker, which is why `curl` and `fetch` look fixed. The navigation half does not change: a request carrying `Sec-Fetch-Mode: navigate` still gets the shell.

Two of those requests are ones Pithy's sign-in depends on. A magic-link click lands on `/auth/magic-link/verify`, and an OAuth provider redirects to `/auth/callback/<provider>` — both top-level navigations, both onto the Worker. Delete the list and they are answered by the app shell, silently, exactly the way the stale list answered `/api/organisations`. So the list stays, and `--check` is what keeps it honest.

One route is deliberately never allowlisted: one your app capability mounts at **`/`**. In a Worker that serves a SPA, `/` is the app shell — that is what `not_found_handling` is for — so a root API route loses to the front end rather than shadowing it. If you need both, move the API route under a prefix (`/api/status` rather than `/`) and `pithy ui sync` will pick it up.

`assets.directory` is deliberately absent from the stanza. Under the Vite plugin that directory is the plugin's to set — it overwrites the key silently rather than erroring — so writing one would put a value in your config that does not describe reality.

## What gets installed

`pithy ui add` writes these into the Worker's `package.json` once, at scaffold.

| Package | Version | Role |
|---|---|---|
| `react` | 19.2.8 | The client |
| `react-dom` | 19.2.8 | The client |
| `@types/react` | 19.2.17 | Types |
| `@types/react-dom` | 19.2.3 | Types |
| `vite` | ^8.0.16 | Dev server and build |
| `@vitejs/plugin-react` | ^6.0.4 | JSX and Fast Refresh |
| `@cloudflare/vite-plugin` | ^1.48.0 | Runs the Worker in workerd inside the dev server; owns the build output |
| `wrangler` | ^4.115.0 | Deploy |
| `@pithy-sh/vite` | matching your CLI | Serves the `virtual:pithy/*` modules |

Two exceptions to the table, and `@pithy-sh/vite` is the only row either touches.

The first is yours: if it is already provided by a checkout linked into your `node_modules`, `pithy ui add` writes no range for it. The package resolves either way, and a range naming a version the registry does not have would fail your next install.

The second is ours, and applies to every project until `@pithy-sh/*` publishes: there is no version to name yet, so the line is dropped for everyone. `pithy ui add` says so — the same notice `pithy init` and `pithy worker add` print — and the install it then tells you to run will succeed while the build fails on the missing plugin. Link the kit from a checkout before installing. The day the scope publishes, the range is written with no change on your side.

The versions are a set, not a menu. `@vitejs/plugin-react` 6.x is the Vite-8 line — 5.1.x does not support Vite 8 — and `@cloudflare/vite-plugin` 1.48 peers on `vite ^6.1 || ^7 || ^8` and `wrangler ^4.115.0`. Downgrading one of them alone will not resolve.

Install with whichever package manager your project uses. Pithy does not pin you to Bun for adoption.

## See also

- [`docs/CLI.md`](CLI.md) §7 — the binding specification for `pithy ui add|sync|list`: every flag, the `--json` shapes, and the errors.
- [`docs/CLI.md`](CLI.md) §6 — how `pithy dev` supervises the worker set and substitutes `{port}`.
- [`docs/DEPLOY.md`](DEPLOY.md) — migrate and deploy, by hand and in CI.
