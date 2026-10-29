# pithy ui

_The site renders this for readers: [pithy.sh/docs/cli/commands/ui](https://pithy.sh/docs/cli/commands/ui). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` holds the code to it — so it stays here._

Scaffold a front end into an existing Worker and wire it end to end — Vite, the SPA entry, the routes, the `assets` stanza, the dev command.

A new project can start with one: `pithy init --target web` or `--target both` runs the same scaffold into its first Worker, with no screens, because nothing is composed yet to sign in to. Run `pithy ui add react` once a capability with screens is.

`pithy ui add react-native` is the other stub, and it is the one that does not live in the Worker. It writes an Expo app for iOS, Android and the web into an `apps/<name>/` of its own, which calls the Worker across origins. See React Native: an app of its own, below.

## Synopsis

```
pithy ui add <framework> [--worker <name>] [--app <name>] [--ios-rail <rail>] [--android-rail <rail>] [--web-rail <rail>] [--auth | --no-auth] [--payments | --no-payments] [--organization | --no-organization] [--consent | --no-consent] [--dry-run] [--json]
pithy ui sync [--worker <name>] [--app <name>] [--ios-rail <rail>] [--android-rail <rail>] [--web-rail <rail>] [--check] [--json]
pithy ui list [--json]
```

## Flags

| Argument / flag | Applies to | Default | Purpose |
|---|---|---|---|
| `<framework>` | `add` | required | The stub to scaffold: `react` or `react-native` |
| `--worker <name>` | `add`, `sync` | resolved — see Resolving the Worker | The Worker under `apps/` to scaffold into, or to re-derive. For `react-native`, the Worker the app calls |
| `--app <name>` | `add`, `sync` | `app` (`mobile` when the Worker is `app`) | `react-native` only. The app's own directory, `apps/<name>`. On `sync`, rewrite that app's generated config instead of a Worker's allowlist |
| `--ios-rail <rail>` | `add`, `sync` | `apple` when the Worker enables it, else `none` | `react-native` only. The rail the iOS app sells through: `apple`, `stripe`, `lemonSqueezy`, `paddle` or `none` |
| `--android-rail <rail>` | `add`, `sync` | `google` when the Worker enables it, else `none` | `react-native` only. The rail the Android app sells through: `google`, `stripe`, `lemonSqueezy`, `paddle` or `none` |
| `--web-rail <rail>` | `add`, `sync` | the Worker's first enabled hosted rail, else `none` | `react-native` only. The rail the web build sells through: `stripe`, `lemonSqueezy`, `paddle` or `none` |
| `--check` | `sync` | `false` | Report the drift, write nothing, exit non-zero on a shadowed route — the CI gate |
| `--auth` / `--no-auth` | `add` | see The screen sets | Scaffold the sign-in screens, or leave them out |
| `--payments` / `--no-payments` | `add` | see The screen sets | Scaffold the paywall and subscription screens, or leave them out |
| `--organization` / `--no-organization` | `add` | see The screen sets | Scaffold the account chooser and the invitation screen, or leave them out |
| `--consent` / `--no-consent` | `add` | see The screen sets | Scaffold the consent settings screen, or leave it out |
| `--dry-run` | `add` | `false` | Show the plan and write nothing. Every refusal still applies |
| `--json` | all three | `false` | One line of machine-readable output. Implies non-interactive: `pithy ui` never prompts when `--json` is set, nor under `--no-input` or `PITHY_NONINTERACTIVE=1` |

**There are no provider flags.** No `--google`, no `--github`, no `--turnstile`. Which social providers exist, and whether a humanity check gates sign-in, is already declared in that Worker's `pithy.config.ts`. A flag would be a second source of truth, frozen at scaffold time, that drifts the moment someone enables a provider in config. The scaffolded screens read the composed config at runtime instead (see `docs/UI.md`), so enabling a provider stays a one-line config edit and a redeploy — no CLI run, no file to regenerate, nothing to keep in step.

**The rail flags are not provider flags.** Which rails exist is the Worker's config, and the CLI reads it. Which one each platform of an app sells through is the app's choice, made per platform, and the Worker cannot state it: one backend serves an iOS build that buys through StoreKit and a web build that buys through Stripe. So the flag picks among the rails the Worker enables, and a rail it does not enable is refused by name.

## What it does

`pithy ui` scaffolds a front end into an existing Worker and wires it end to end. The SPA and the API deploy as one unit, on one origin, out of one `apps/<name>/`. This section specifies the command; `docs/UI.md` is the adopter-facing guide to what it writes and how the pieces fit.

### Resolving the Worker

`ui add` and `ui sync` wire exactly one Worker, so they take `--worker <name>` and follow the same rule as `add` and `remove` (`docs/CLI.md` §1.1): with a single Worker under `apps/` the flag is optional and that Worker is used; with several, the CLI prompts at a terminal and **fails `input/required`, naming `--worker`, when it may not ask** (`--json`, `--no-input`, `PITHY_NONINTERACTIVE=1`) rather than guessing. Scaffolding a front end into the wrong Worker would put an `assets` stanza and an asset-routing allowlist on a script that serves no browser.

`ui list` takes no `--worker`: it reports the framework stubs `ui add` can scaffold, not the Workers that already carry one. For the per-Worker view — which Workers exist, which autostart, which port each holds — use `pithy worker list`.

### The screen sets

`pithy ui add` scaffolds up to three sets of Pithy's screens, one per capability, and at a terminal it asks about each:

```
Scaffold the passwordless sign-in screens?
Scaffold the paywall and subscription screens?
Scaffold the account chooser and the invitation screen?
```

- The suggested answer is **yes when the target Worker composes that capability** — `auth`, `payments`, `organization`, `consent` — and no when it does not.
- `--auth` / `--no-auth`, `--payments` / `--no-payments`, `--organization` / `--no-organization` and `--consent` / `--no-consent` answer them without asking. Where nobody may be asked (`--json`, `--no-input`, `PITHY_NONINTERACTIVE=1`), the suggested answer applies unless a flag is passed.
- The agent screens have no flag and no question of their own. They ride on `--auth` when the Worker composes `mcp`: the agent consent screen an MCP client's authorization lands on, its seeded gate, and the connected-applications screen a person revokes an approval from (`docs/AGENT-ACCESS.md` §4.0). A Worker serving the endpoint without them would send every agent's user to a page that does not exist.
- With auth on, the stub adds `src/routes/pithy/` — the magic-link, OTP, and callback screens, and the screens a suspended or deleted account lands on — and the router's route guard. Payments adds the paywall, pricing and subscription screens; organization adds the account chooser and the invitation screen an invitation link lands on; consent adds the settings screen where a person reads and withdraws their consents. Everything else is scaffolded either way. `docs/UI.md` lists every file and the flag that writes it.

Asking for a set on a Worker that does not compose its capability is an error, not a warning (Errors, below).

### What it writes

Every file is written **only if it does not already exist**. `pithy ui add` never overwrites, never merges, never reformats. A file already on disk is left byte-for-byte alone and reported as kept. That is the whole ownership model: Pithy authors a file once, and from that moment it is yours.

| Path (under `apps/<worker>/`) | Written when | What it is |
|---|---|---|
| `index.html` | always | The Vite entry document |
| `vite.config.ts` | always | `cloudflare()` + `react()` + `pithy()` |
| `tsconfig.client.json` | always | The client program — jsx + DOM, covering `src/**/*.tsx` and `client-env.d.ts` |
| `tsconfig.node.json` | always | The config program — `types: ["node"]`, covering `vite.config.ts` |

Both are `composite`, because both are referenced from the project's root `tsconfig.json` (`docs/CLI.md` §1.3), and each names a `.tsbuildinfo` under the **project's** `dist/` — never this Worker's, which Vite empties on every build.
| `client-env.d.ts` | always | Ambient declarations for the `virtual:pithy/*` modules |
| `src/client.tsx` | always | The SPA entry |
| `src/router.tsx` | always | The two-glob router and its route guard. Both globs negate `*.test.tsx` and `*.spec.tsx`, so a co-located route test ships to nobody (`docs/UI.md` §Routing) |
| `src/styles.css` | always | Yours: the palette tokens, the reset, `body` |
| `src/pithy-screens.css` | always | Pithy's: every class name a Pithy screen renders, in a `@layer pithy` cascade layer. Written whenever absent, which is what makes a later `--auth` backfill produce screens that render styled — the adopter's `styles.css` is correctly skipped, so the rules cannot live in it |
| `src/pithy-config.tsx` | `--auth` | The one module that imports `virtual:pithy/*`, narrowed once for every screen |
| `src/session.tsx` | `--auth` | The session hook, `signOut`, and the signed-in route guard |
| `src/turnstile.tsx` | `--auth` | The Turnstile widget and the token placement the middleware reads |
| `src/routes/pithy/*.tsx` | `--auth` | Pithy's screens: sign-in, OTP, callback, and account suspended, account deleted, organization suspended |
| `src/payments.tsx`, `src/routes/pithy/paywall.tsx`, `pricing.tsx`, `subscription.tsx` | `--payments` | The payments client bound to its base path, and the paywall, pricing and subscription screens |
| `src/routes/pithy/choose-organization.tsx`, `choose-organization.test.tsx`, `invitation.tsx`, `invitation.test.tsx` | `--organization` | The account chooser, the screen an invitation link lands on, and a seeded gate for each |
| `src/routes/pithy/consent.tsx` | `--consent` | Every consent purpose, and where you stand on each |
| `src/routes/pithy/agent-consent.tsx`, `agent-consent.test.tsx`, `connected-applications.tsx`, `connected-applications.test.tsx` | `--auth`, on a Worker composing `mcp` | The agent consent screen, the screen that lists and revokes what you approved, and a seeded gate for each |
| `src/routes/app/home.tsx` | always | Your first screen. Written once, never again |

`src/index.ts` — the Worker entry — is not touched.

Two structural rules the stub depends on, worth knowing before you move a file:

- **Every client file is `.tsx`.** The Worker's existing `tsconfig.json` includes `src/**/*.ts`, which does not match `.tsx`, so the Worker's type program ignores the client entirely and needs no edit. For the same reason `client-env.d.ts` sits at the Worker root and not under `src/` — a `.d.ts` there *would* match.
- **No `.ts` file in the Worker program may import a `.tsx` file.** The seam between a Worker and its client is runtime-only. One import across it pulls the browser build into the Worker's type program, and the rule above stops holding.

### What it wires

Four files are edited.

**An edit touches the lines it means to change, and no others.** Every one of these files is checked into your repository, so the writer prints what the Biome `pithy init` scaffolds would print — short arrays on one line, an object left in whatever shape it already had, comments where you put them. A `pithy ui sync` that adds one path is a one-line diff, and its output passes `biome check` with no formatting step of your own. It did neither before #249: the writer expanded every array in the file, so a two-line change arrived as 78 insertions and then failed the pre-commit hook the CLI itself installed.

**`wrangler.jsonc` — the `assets` stanza.** `not_found_handling` is `"single-page-application"`, and `run_worker_first` is an **explicit allowlist derived from that Worker's composed route table** — never `true`, never a guessed prefix like `/api/*`. Pithy's routes sit at capability base paths (`/auth`, `/leaderboard`, `/payments`, `/storage`, `/media`, …) plus `/health`; nothing lives under `/api`, and an allowlist that assumes otherwise hands `GET /health` the SPA shell. Three derivation rules:

- Every entry is emitted in **two forms**, the bare path and its `/*` glob, because `"/auth/*"` does not match a bare `"/auth"`.
- Never a bare-prefix glob. `"/media*"` also captures `/mediafoo`; the pair `"/media"` + `"/media/*"` captures the route table exactly.
- The route table is taken **once per environment**, and the allowlist is the union. A Worker composes differently per environment — `@pithy-sh/auth` mounts `/__pithy/dev-login` only in `dev` — so a single composition produces one environment's table and calls it the Worker's. The set is the project's `environments` from the root `pithy.config.ts`, plus `dev`, which is never declared because it is always there. `CI` is ignored while deriving, so `--check` in CI and `sync` on a laptop derive the same list from the same repository.

`assets.directory` is **not** written. Under the Vite plugin the directory is the plugin's to set — it overwrites the key silently rather than erroring, so a value there would be a lie in the adopter's own config.

The array form of `run_worker_first` is what sets `has_static_routing`, and that is the whole mechanism. With it, `not_found_handling` applies to every request no worker-first pattern matched — so a listed route always reaches the Worker, and an unlisted one always gets the SPA shell, whatever the method. Without it, the asset worker overrides `not_found_handling` to `"none"` for every request that is not a `Sec-Fetch-Mode: navigate` navigation, which sends `fetch` and `curl` to the Worker and still hands the shell to a magic-link click or an OAuth callback. Both halves of that trade are silent 200s; the list is the half that can be checked, and `pithy ui sync --check` is what checks it (below).

**`pithy.worker.jsonc` — the `dev` and `ui` blocks.**

```jsonc
{
  "dev": { "autostart": true, "readySignal": "ready in \\d+", "command": ["bun", "x", "vite", "dev", "--configLoader", "runner", "--strictPort", "--port", "{port}"] },
  "ui": { "stub": "react", "build": ["vite", "build", "--configLoader", "runner"] }
}
```

`dev.command` is what joins the front end to the dev set (`docs/commands/dev.md`), `{port}` and all. `--strictPort` is not optional: without it Vite silently increments off a busy port, and a worker that quietly moves breaks every sibling that was told its address at creation. `ui.stub` records which stub was scaffolded — it is what makes a second `ui add` on the same Worker an error, and what tells `ui add --auth` it is backfilling a scaffold rather than starting one. `ui.build` is argv run through the adopter's package manager before `wrangler deploy`, so a UI-bearing Worker never ships a stale client. `pithy deploy --env <name>` sets `ENVIRONMENT` for that build, which is what makes a capability's per-environment client values — a Turnstile sitekey, say — resolve for the environment being shipped rather than for `dev`. Both commands carry `--configLoader runner`, and that is load-bearing rather than a preference: Vite's default config loader bundles `vite.config.ts` and leaves `@pithy-sh/vite` external, which asks Node to import raw TypeScript with extensionless relative imports — Node cannot resolve those, and refuses to strip types under `node_modules` at all. The runner loads the config through Vite's own resolver, where both are ordinary.

**`package.json` — the client dependencies and the scripts that run them.** React, `@pithy-sh/i18n`, `@pithy-sh/ui-core` and `@pithy-sh/ui-react` (the translator, the hooks and route table every seeded screen imports, and the re-exports a screen scaffolded earlier imports them through), the Vite plugins, and `@pithy-sh/vite`, at the versions listed in `docs/UI.md`. Written at scaffold; `pithy ui` never revisits them. A `@pithy-sh/*` package a linked checkout already provides is left out of `dependencies` and `devDependencies` — it resolves without a range, and a range naming a version the registry does not have would break the next install. Both lists in the `--json` result name only what was written, so that run omits it there too.

**The project's root `tsconfig.json` — the client's two programs, appended to `references`.** A program nothing references is a program nothing checks, and `pithy ui add` used to leave exactly that: two tsconfigs beside the Worker's, both invisible to `bun run typecheck`. They are appended after the Worker's own, so `tsc -b` reports in layout order, and a re-run adds nothing. **Extended, never created** — a project scaffolded before `docs/CLI.md` §1.3 existed has Workers whose programs are not `composite`, and `tsc -b` refuses a reference to one of those outright, so writing the file would hand that adopter a typecheck that cannot pass.

### `pithy ui add --dry-run`

The same scaffold and the same wiring, written into a private copy of the project under the system temporary directory, and the plan is the difference: every file it would create, and each of the four documents it would edit, with its diff. The copy is gone before the command exits, and the project is byte-identical. Everything the run decides first still decides — a Worker that already has a front end is refused, and the screens follow the same flags and the same composition — so the report beside the plan is the one the real run gives, `created`, `unstyled` and `runWorkerFirst` included. The plan shape is the one every `--dry-run` shares (`docs/CLI.md` §1.2).

```
$ pithy ui add react --worker api --no-auth --dry-run
Would scaffold a react front end into api.
Would create apps/api/index.html.
…
Would edit apps/api/wrangler.jsonc.
Would edit tsconfig.json.
Dry run. Nothing written.
```

### `pithy ui sync`

`run_worker_first` is derived from the route table, and the route table changes whenever a route is mounted: by `pithy add <capability>`, by `pithy remove <capability>`, and by the adopter writing one into their own app capability. **That last one runs no command**, which is how the list goes stale without anyone touching it. `pithy ui sync` re-derives it and rewrites that one key.

`sync` touches nothing else. No file is created, no dependency moves, no scaffolded screen is regenerated. It is idempotent: a run with nothing to change reports that nothing moved.

`--check` writes nothing and reports what the list no longer covers. A shadowed route answers `200 text/html` from the SPA shell with the handler never invoked, and no adopter test suite sees it — tests call handlers directly, so the asset router is never in the picture. So the check exits non-zero and belongs in CI, beside `pithy doctor`:

```
$ pithy ui sync --check --worker api
api: the SPA shell is answering these, not the worker.
  /api/cli/device/start
  /api/organizations
Run pithy ui sync --worker api.
```

A route the allowlist cannot express is never reported: `core`'s own `app.use("*")`, and a route mounted at `/`, are paths the derivation deliberately leaves to the shell (What it wires, above). A check that flagged them would mark every project drifted forever.

### React Native: an app of its own

`pithy ui add react-native` writes an Expo app (SDK 57, React Native 0.86) into `apps/<app>/`, beside the Worker it calls rather than inside it. One Expo project builds iOS, Android and the web. The app has no `wrangler.jsonc` and no `pithy.config.ts`, so it is not a Worker: `pithy deploy` leaves it alone, and every command that composes Workers skips it. Nothing in Pithy builds the app for a store: a store build goes through EAS (`eas build`), and `expo export --platform web` is the web build. The web build calls the Worker by relative path with its cookie, so serve it from the Worker's own origin. `--worker` names the Worker it calls, resolved the way every `--worker` is. `--app` names its directory, `app` by default; a directory that is a Worker, or that holds another stub's front end, is refused.

The screen sets are decided as for `react`, against the Worker the app calls, with one difference: the account chooser and the invitation screen read the session the sign-in screens hold, so a run without `--auth` leaves them out, and refuses an explicit `--organization`. The files are `@pithy-sh/ui-react-native`'s templates: Expo Router's `app/` entry, `app.config.ts`, the Metro config that proxies the Worker's paths in dev, the router adapter, the bearer transport, the session, and the screens, each under the same name as its DOM counterpart. Every app gets the base set: `app.config.ts`, `metro.config.js`, `metro-proxy.cjs`, `tsconfig.json`, `app/_layout.tsx`, `app/index.tsx`, `app/[...pithy].tsx`, and under `src/` `theme.ts`, `platform.ts`, `pithy-config.ts`, `pithy-config.generated.ts`, `pithy-locale.tsx`, `router.tsx`, `route-modules.ts`, `transport.ts` and `routes/app/home.tsx`, sixteen files. Each screen set adds its screens and the helpers only they use: `--auth` the session, the Turnstile WebView and the sign-in and account screens; `--payments` the payments client, its store bindings, and the paywall, pricing and subscription screens; `--organization` `choose-organization.tsx` and `invitation.tsx`; `--consent` `consent.tsx`; and `mcp`, riding on `--auth`, `agent-consent.tsx` and `connected-applications.tsx`. No test is written into the app: the set's tests stay in `@pithy-sh/ui-react-native` (`docs/CONVENTIONS.md`).

**What it wires.** Two documents, both in the app's directory, and nothing in the Worker:

- `pithy.worker.jsonc`: `dev.command` runs `expo start --port {port}` through the project's package manager, so `pithy dev` starts the app beside the Workers on a pinned port. `dev.readySignal` is `^Waiting on `, the line Expo CLI prints once Metro listens with no terminal attached, which is how `pithy dev` runs it. `ui.stub` is `react-native`, and `ui.build` is `expo export --platform web`, the web build, recorded for you and never run by `pithy deploy`. `ui.worker` names the Worker the app calls, which is how `pithy ui sync --app` finds it again.
- `package.json`: written with Expo Router's entry if absent, then merged like a Worker's. React, React Native, `react-native-web` and every native module at the version Expo SDK 57 bundles. `@pithy-sh/core`, `@pithy-sh/i18n` and `@pithy-sh/ui-core` at their own ranges. Every other kit package a written template imports gets a range whether or not the Worker composes it, because the base templates import several for their client types: the Worker's own range first, so the app and the Worker run one release, then the project root's, then the version installed under the project or beside the CLI, then the registry's `latest`. A package none of them answers for is named in the output and in `unresolvedPackages`, and gets no line.

**`src/pithy-config.generated.ts`.** Metro cannot resolve `virtual:pithy/*`, so the composed config arrives as a file. It holds each capability's client projection for `dev`, the Worker's origin per environment, and four values that are yours: `appScheme` (the app's name), `universalLinkOrigin` (the Worker's production domain, then its staging one, else `null`), the Google client ids, and `rails`. Set `appScheme` and `universalLinkOrigin` before a store build. The comment at the top of the file says how to change each rail.

**Origins.** `origins.dev` is the Worker's local origin: the one `.dev.config.json` pins for it, else `http://localhost:8787`. `origins.staging` and `origins.prod` are present for each environment the project deploys to, and read offline the way `pithy env` reads them: the Worker's `domains` declaration, then its route in `wrangler.jsonc`, then its `vars.BASE_URL`. One none of those names is `null`. A Worker that answers only on `workers.dev` is the usual case, since that address takes the account to resolve: set the origin in the file by hand. The app picks one when it is built, from `EXPO_PUBLIC_PITHY_ENV` (`dev`, `staging` or `prod`, `dev` when unset), which Expo inlines into the bundle; a phone build naming staging or prod stops at launch when that origin is unset or not https, naming the field to set, since the bearer credential goes there. The web build needs none. On Android a `localhost` or `127.0.0.1` dev origin is reached through `10.0.2.2`, the emulator's address for this machine. A device on your network needs this machine's network address in `origins.dev`, and the Worker listening there.

**Sign-in returns to the app.** A sign-in started on a phone returns to the app's scheme, and to its universal link when one is set, and auth refuses either unless its `trustedOrigins` names it. So `ui add` says which entries to add, quoted exactly: `"<appScheme>://"`, and `universalLinkOrigin` when it is set. When the Worker composes auth it reads `trustedOrigins` from the loaded config and names only the missing entries, in the output and in `untrustedOrigins`; when it does not, it names the entries to add once it does.

**Screens that need sign-in.** The account chooser and the invitation screen read the session the sign-in screens hold. `--organization` with the sign-in screens left out is refused by name; left to decide, it is left out.

**Rails.** One per platform. `--ios-rail`, `--android-rail` and `--web-rail` decide outright. Without one, a person at a terminal is asked, offered only the rails the Worker enables, starting from the default; anyone else gets the default. The default is the platform's store on a phone and the Worker's first enabled hosted rail on the web, and `none` wherever the Worker enables no such rail, so a default is never a rail the Worker refuses. `none` shows plans and sells nothing. A web rail on a phone opens checkout in the system browser. Whether a store allows that link out is your call; `docs/UI.md` names the rules.

**A backfill.** `pithy ui add react-native` on an app that already exists adds the screens it lacks, `--auth` after `--no-auth` say, and rewrites `src/pithy-config.generated.ts` from the Worker the way `pithy ui sync` does. Your four values are kept, and a backfill does not prompt for rails: a rail already written stays unless a rail flag sets it now. The run says the config was rewritten.

**`pithy ui sync --app <name>`.** Rewrites the app's generated config from the Worker its manifest names, or the one `--worker` names. The projections and the origins are the Worker's and are rewritten, with two exceptions: an origin you set for an environment the Worker names none for is kept, and so is a dev origin that is not this machine's loopback. Your four values are kept, except a rail a flag sets now. A `--worker` other than the one the manifest names points the app at it: the manifest's `ui.worker` is rewritten, so the next sync without `--worker` finds the same Worker. Every rail is held to the Worker again, so one it has stopped enabling is refused by name. A file that is not the config Pithy writes is refused rather than overwritten; delete it to start from the defaults. `--check` writes nothing and exits 1 when the file is behind the Worker.

```
$ pithy ui add react-native --worker api --no-auth --no-payments --ios-rail apple --web-rail stripe
Scaffolded a react-native app into apps/app. It calls api. Bare template.
16 files created.
Rails: iOS apple, Android none, web stripe.
apps/app/src/pithy-config.generated.ts holds api's config. Set appScheme and universalLinkOrigin there before a store build.
When api composes auth, its trustedOrigins needs "app://".
Change api's config, then run pithy ui sync --app app --worker api.
Install the packages: bun install. Then pithy dev.
Done.
```

## `--json`

One line, one object, one shape per subcommand. The `command` field is the subcommand's dotted name, matching `worker.add` and `feature.create` rather than the space-separated form the resource commands use.

```
$ pithy ui add react --worker api --json
{"command":"ui.add","schemaVersion":2,"dryRun":false,"worker":"api","deployedAs":"pithy-app-api","framework":"react","auth":true,"payments":false,"organization":false,"consent":false,"created":["client-env.d.ts","index.html","src/client.tsx","src/pithy-config.tsx","src/pithy-screens.css","src/router.tsx","src/routes/app/home.tsx","src/routes/pithy/callback.tsx","src/routes/pithy/otp.tsx","src/routes/pithy/sign-in.tsx","src/session.tsx","src/styles.css","src/turnstile.tsx","tsconfig.client.json","tsconfig.node.json","vite.config.ts"],"skipped":[],"unstyled":[],"runWorkerFirst":["/auth","/auth/*","/health","/health/*"],"packageManager":"bun","dependencies":["@pithy-sh/i18n","@pithy-sh/ui-core","@pithy-sh/ui-react","react","react-dom"],"devDependencies":["@cloudflare/vite-plugin","@pithy-sh/vite","@types/react","@types/react-dom","@vitejs/plugin-react","vite"],"scripts":["dev","build","preview"],"next":[{"command":"bun install","why":"ui add wrote 11 packages into package.json, and the build needs them installed."}]}
```

`worker` is the `apps/` directory the front end was written into; `deployedAs` is the Worker's deployed script name. **That split holds across every command**, and it is the one thing to know about reading this output: `worker` is what `--worker` accepts and what every path in the same payload is relative to, while `deployedAs` is what the Cloudflare dashboard shows. A run reporting the deployed name (`<project>-<worker>`) beside directory-relative paths described a directory that does not exist, which is what the two fields exist to prevent. `created` and `skipped` are worker-relative and sorted; together they are every file the template declares, so a backfilling run reports the untouched ones rather than staying silent about them. `unstyled` is the second claim: **wrote the screens** and **the screens are styled** are two things, and only the first was ever reported. It is read off the stylesheets as they stand on disk after the write, not off the template, because a stylesheet the adopter has since edited is the case it exists for. `dependencies`, `devDependencies` and `scripts` name only what this run added.

```
$ pithy ui sync --worker api --json
{"command":"ui.sync","schemaVersion":1,"worker":"api","deployedAs":"pithy-app-api","before":["/auth","/auth/*","/health","/health/*"],"after":["/auth","/auth/*","/health","/health/*","/leaderboard","/leaderboard/*"],"changed":true,"uncovered":[],"notFoundHandling":"single-page-application"}
```

`before` and `after` are the allowlist either side of the run, so a CI job can log the delta without recomputing it. `changed` covers everything the call can have moved — the allowlist, or a `not_found_handling` it had to write because the stanza carried none. `uncovered` names the routes the list **in the file** does not cover: always empty after a write, and under `--check` it is the finding, the one thing that fails the exit. `notFoundHandling` is reported because SPA routing depends on it and `sync` does not overwrite a value the adopter chose.

With `--app` the run touches no allowlist. `changed` says whether the app's generated config differs from what the Worker gives now, and under `--check` that is the finding. `before`, `after` and `uncovered` are empty, `notFoundHandling` is absent, and `app` and `rails` are present.

```
$ pithy ui list --json
{"command":"ui.list","schemaVersion":1,"stubs":[{"id":"react","description":"React 19 SPA on Vite, served by the worker as static assets"},{"id":"react-native","description":"Expo app for iOS, Android and the web, in its own apps/<name>, calling a worker"}]}
```

| key | type | meaning |
|---|---|---|
| `command` | string | The subcommand's dotted name: `ui.add`, `ui.sync`, or `ui.list`. |
| `schemaVersion` | integer | The version of this payload's shape. Bumped only when a key is removed or retyped; `pithy schema` publishes the current one. |
| `dryRun` | boolean | `add`. Whether this was `--dry-run`. Nothing was written when it is `true`, and every other key is what the run would report. |
| `worker` | string | `add`, `sync`. The `apps/` directory the front end was written into, and what every path in the same payload is relative to. |
| `deployedAs` | string | `add`, `sync`. The Worker's deployed script name — what the Cloudflare dashboard shows. |
| `framework` | string | `add`. The stub that was scaffolded. |
| `app` | string | `add`, and `sync` with `--app`. `react-native` only: the app's own `apps/` directory. On `add`, `created` and `skipped` are relative to it. Absent for `react`. |
| `rails` | object | `add`, and `sync` with `--app`. `react-native` only: `{ ios, android, web }`, the rail each platform sells through. Absent for `react`. |
| `trustedOrigins` | string[] | `add`. `react-native` only: the entries auth's `trustedOrigins` needs for the app, `"<appScheme>://"` and `universalLinkOrigin` when it is set. Absent for `react`. |
| `untrustedOrigins` | string[] | `add`. `react-native` only: the entries of `trustedOrigins` the Worker's auth config does not list, read from the loaded `pithy.config.ts`. Empty when nothing is missing or the Worker composes no auth. Absent for `react`. |
| `unresolvedPackages` | string[] | `add`. `react-native` only: kit packages the app's templates import that no source had a range for, so its `package.json` declares none. Absent for `react`. |
| `backfill` | boolean | `add`. `react-native` only: whether the app already existed, so this run added screens to it and rewrote its generated config from the Worker, keeping your four values. Absent for `react`. |
| `auth` | boolean | `add`. Whether Pithy's sign-in screens were scaffolded. |
| `payments` | boolean | `add`. Whether the paywall and subscription screens were scaffolded. |
| `organization` | boolean | `add`. Whether the account chooser and the invitation screen were scaffolded. |
| `consent` | boolean | `add`. Whether the consent settings screen was scaffolded. |
| `created` | string[] | `add`. The files this run wrote, worker-relative and sorted. |
| `skipped` | string[] | `add`. The template's files already on disk, left byte-for-byte alone. |
| `unstyled` | string[] | `add`. Class names Pithy's screens render that no stylesheet in the Worker defines. Empty on an ordinary run; anything else is the exact list to fix. |
| `runWorkerFirst` | string[] | `add`. The asset-routing allowlist derived from that Worker's composed route table. |
| `packageManager` | string | `add`. The package manager the scripts were written for. |
| `dependencies` | string[] | `add`. Only what this run added. |
| `devDependencies` | string[] | `add`. Only what this run added. |
| `scripts` | string[] | `add`. Only what this run added. |
| `plan` | object | `add`, under `--dry-run` only. What it would write, in the shape every `--dry-run` shares (`docs/CLI.md` §1.2): each file created or edited, with its diff. |
| `next` | object[] | `add` only. `[{ command, why }]`: the project's install (`bun install`, `pnpm install`, …) when this run wrote dependencies into the Worker's `package.json`, because the build fails without them. Absent when it wrote none, and under `--dry-run`; never empty (`docs/CLI.md` §1.2). |
| `before` | string[] | `sync`. The allowlist before the run. Empty with `--app`. |
| `after` | string[] | `sync`. The allowlist after it. Empty with `--app`. |
| `changed` | boolean | `sync`. Whether the call moved anything — the allowlist, or a `not_found_handling` it had to write. With `--app`, whether the generated config differs from the Worker's, which under `--check` is the finding. |
| `uncovered` | string[] | `sync`. The routes the list in the file does not cover. Empty after a write; under `--check` it is the finding. Empty with `--app`. |
| `notFoundHandling` | string | `sync`. Reported because SPA routing depends on it and `sync` does not overwrite a value the adopter chose. Absent with `--app`. |
| `stubs` | object[] | `list`. Each stub's `id` and `description`. |

## Errors

Each one is a `PithyError` — the problem, then the action (`docs/CLI.md` §3.3) — and the process exits by its kind (`docs/CLI.md` §3.8): 2 for a call to fix, 3 for something in the way that has to change first. `pithy ui sync --check` exits 1 when it finds something, because its report is the answer, and Ctrl-C at the screens prompt exits 130.

**Unknown framework.** Exit 2.

```
$ pithy ui add svelte --worker api
No UI stub named "svelte".
Run pithy ui list to see the frameworks you can add. Known: react, react-native.
```

**A UI is already there.** Exit 3.

```
$ pithy ui add react --worker api
api already has a react front end.
Add screens by dropping files into src/routes/app/. Run pithy ui sync --worker api to re-derive its route allowlist.
```

The check is the manifest's `ui` block, not the presence of files. The stub is scaffolded once; a second `add` would create nothing and imply otherwise. A Worker carrying a different stub is refused the same way, exit 3: one Worker, one front end.

**A template file already on disk.** Exit 3. Pithy never overwrites a file it did not just write, so a first scaffold that finds one names every such file and writes nothing.

**`--auth`, `--payments`, `--organization` or `--consent` without its capability.** Exit 3, `core/precondition_failed`, with the `pithy add` that composes it as its `fix`. For auth that is `pithy add auth --worker api --with-prerequisites`, since auth declares `secrets` and `email`: the Worker is missing what the screens depend on.

```
$ pithy ui add react --worker api --auth
The auth screens need the auth capability, and api doesn't compose it.
Run `pithy add auth --worker api --with-prerequisites` first, or leave them out with --no-auth.
```

**A rail a platform cannot sell through.** Exit 2, `validation/invalid_input`, listing the ones it can: ``Pass --android-rail google, stripe, lemonSqueezy, paddle or none.`` On `sync`, a rail kept in the generated config is held to the same list, so a hand-edited `rails.android` of `apple` is refused the same way, naming the key.

**A rail the Worker does not enable.** Exit 3, `core/precondition_failed`, naming the rail and the key that turns it on, before anything is written. A Worker that composes no payments at all gets the `pithy add payments` fix instead.

```
$ pithy ui add react-native --worker api --android-rail google
The google rail isn't enabled in api's payments config.
Enable rails.google in apps/api/pithy.config.ts, or pass --android-rail none.
```

**`--app` or a rail flag with `react`.** Exit 2. The React front end lives in the Worker it calls and has no rails of its own. On `sync`, a rail flag with no `--app` is refused the same way.

**An `apps/<name>` that is a Worker, or holds another front end.** Exit 3. `--app` named the Worker the app calls: exit 2.

**`pithy ui sync` on a Worker with no front end.** Exit 3, and the action names that Worker: ``Run `pithy ui add react --worker api` to scaffold one.``

**`pithy ui sync --app` on a directory with no React Native front end.** Exit 3, `core/not_found`.

```
$ pithy ui sync --app mobile
apps/mobile has no React Native front end.
Run pithy ui add react-native --app mobile, naming the worker it calls with --worker.
```

**`--organization` with `--no-auth` on `react-native`.** Exit 2, `validation/invalid_input`: ``The account chooser needs the sign-in screens, and this run leaves them out.`` The action reads ``Pass --auth, or leave the account chooser out with --no-organization.``

**Several Workers, no `--worker`, where nobody may be asked.** The resolution error from 7.2 — the same `input/required` refusal `pithy add` raises, naming the Workers it found. Exit 2.

**`pithy ui sync --check` finding an uncovered route or an unstyled screen.** Exit 1. Not an error line: the report above is the finding.

## Examples

```bash
# Scaffold React into the only Worker under apps/, with the sign-in screens.
pithy ui add react --auth

# Re-derive one Worker's asset routing after its capabilities changed.
pithy ui sync --worker api

# The CI gate: write nothing, and fail when the SPA shell is answering a route.
pithy ui sync --check --worker api

# An Expo app beside the api Worker, selling through StoreKit on iOS and Stripe on the web.
pithy ui add react-native --worker api --ios-rail apple --web-rail stripe

# Rewrite that app's config after the Worker's changed.
pithy ui sync --app app

# What can be scaffolded.
pithy ui list
```
