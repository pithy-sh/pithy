# Front ends: `pithy ui`

One command puts a React 19 front end inside a Worker you already have, and wires it end to end. The SPA and the API build together, deploy together, and answer on one origin. No second project, no CORS, no second deploy.

```bash
pithy ui add react --worker api
```

## What it does

It scaffolds the client into `apps/api/`, beside the Worker that serves it, and edits three files to connect them.

- **Writes the client.** A Vite entry document, a Vite config wired with the Cloudflare and React plugins, two tsconfigs, ambient types, an SPA entry, a router, styles, the one module that narrows every capability's client projection, Pithy's sign-in screens when the Worker composes `auth`, its paywall and subscription screens when it composes `payments`, and one screen of your own.
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
    styles.css               new
    pithy-config.tsx         new   the one module that imports virtual:pithy/*
    session.tsx              new   --auth  session hook, signOut, signed-in guard
    turnstile.tsx            new   --auth  the widget and its token placement
    payments.tsx             new   --payments  the client bound to the base path, and the guard's data
    routes/
      pithy/sign-in.tsx      new   --auth  and otp.tsx, callback.tsx — Pithy's screens
      pithy/paywall.tsx      new   --payments  and subscription.tsx
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

The public sitekey reaches the screen through `virtual:pithy/turnstile`, per environment. Sitekeys are public by design; the widget secret is never in config and never in the client — it lives in `@pithy-sh/secrets`.

## Paywalls, and where the purchase flow lives

The payments screens are the one place the stub deliberately owns less than it looks like it does.

`pithy ui add` writes a file once and may never rewrite it. That is the right ownership rule, and it is exactly why a frozen paywall ages badly: store rules move under it. Price-change consent prompts, external purchase link entitlements, subscription-management requirements — each arrives after the file was written, and a purchase flow sitting in your repo is one Pithy cannot fix for you.

So the surface splits by what changes. **`@pithy-sh/payments` exports the hooks** — `useEntitlement`, `usePurchase`, `useSubscription`, `useCheckout`, from `@pithy-sh/payments/src/client/hooks` — and owns the calls, the redirect-and-return dance, the error mapping and the entitlement reads. They upgrade with a minor release. **The scaffolded screen renders and styles**, calling those hooks rather than reimplementing them. The screens are still yours to rewrite; what you inherit for free is the part that goes stale.

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

Two rules the derivation follows:

- **Both forms, every time.** `"/auth/*"` does not match a bare `"/auth"`, so each base path is emitted as the pair `"/auth"` and `"/auth/*"`.
- **Never a bare-prefix glob.** `"/media*"` would also capture `/mediafoo`. The pair `"/media"` + `"/media/*"` captures the route table and nothing beyond it.

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
