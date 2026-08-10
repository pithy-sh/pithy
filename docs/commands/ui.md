# pithy ui

Scaffold a front end into an existing Worker and wire it end to end — Vite, the SPA entry, the routes, the `assets` stanza, the dev command.

## Synopsis

```
pithy ui add <framework> [--worker <name>] [--auth | --no-auth] [--json]
pithy ui sync [--worker <name>] [--check] [--json]
pithy ui list [--json]
```

## Flags

| Argument / flag | Applies to | Default | Purpose |
|---|---|---|---|
| `<framework>` | `add` | required | The stub to scaffold. `react` is the only stub Pithy ships |
| `--worker <name>` | `add`, `sync` | resolved — see Resolving the Worker | The Worker under `apps/` to scaffold into, or to re-derive |
| `--check` | `sync` | `false` | Report the drift, write nothing, exit non-zero on a shadowed route — the CI gate |
| `--auth` / `--no-auth` | `add` | see The auth screens | Scaffold the sign-in screens, or leave them out |
| `--json` | all three | `false` | One line of machine-readable output. Implies non-interactive: `pithy ui` never prompts when `--json` is set |

**There are no provider flags.** No `--google`, no `--github`, no `--turnstile`. Which social providers exist, and whether a humanity check gates sign-in, is already declared in that Worker's `pithy.config.ts`. A flag would be a second source of truth, frozen at scaffold time, that drifts the moment someone enables a provider in config. The scaffolded screens read the composed config at runtime instead (see `docs/UI.md`), so enabling a provider stays a one-line config edit and a redeploy — no CLI run, no file to regenerate, nothing to keep in step.

## What it does

`pithy ui` scaffolds a front end into an existing Worker and wires it end to end. The SPA and the API deploy as one unit, on one origin, out of one `apps/<name>/`. This section specifies the command; `docs/UI.md` is the adopter-facing guide to what it writes and how the pieces fit.

### Resolving the Worker

`ui add` and `ui sync` wire exactly one Worker, so they take `--worker <name>` and follow the same rule as `add` and `remove` (`docs/CLI.md` §1.1): with a single Worker under `apps/` the flag is optional and that Worker is used; with several, the CLI prompts at a terminal and **fails with an actionable error under `--json`** rather than guessing. Scaffolding a front end into the wrong Worker would put an `assets` stanza and an asset-routing allowlist on a script that serves no browser.

`ui list` takes no `--worker`: it reports the framework stubs `ui add` can scaffold, not the Workers that already carry one. For the per-Worker view — which Workers exist, which autostart, which port each holds — use `pithy worker list`.

### The auth screens

`pithy ui add` asks once whether to scaffold the sign-in screens:

```
Scaffold the sign-in screens? [Y/n]
```

- The default is **yes when the target Worker composes the `auth` capability**. The prompt is skipped entirely when it does not — there is nothing for a sign-in screen to call.
- `--auth` and `--no-auth` answer it non-interactively. Under `--json` the resolved default applies unless one of them is passed.
- With auth on, the stub adds `src/routes/pithy/` — the magic-link, OTP, and callback screens — and the router's route guard. With auth off, everything else is still scaffolded; only Pithy's screens are omitted.

Passing `--auth` to a Worker that does not compose auth is an error, not a warning (Errors, below).

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
| `src/styles.css` | always | The stub's styles |
| `src/pithy-config.tsx` | `--auth` | The one module that imports `virtual:pithy/*`, narrowed once for every screen |
| `src/session.tsx` | `--auth` | The session hook, `signOut`, and the signed-in route guard |
| `src/turnstile.tsx` | `--auth` | The Turnstile widget and the token placement the middleware reads |
| `src/routes/pithy/*.tsx` | `--auth` | Pithy's screens: sign-in, OTP, callback |
| `src/routes/app/home.tsx` | always | Your first screen. Written once, never again |

`src/index.ts` — the Worker entry — is not touched.

Two structural rules the stub depends on, worth knowing before you move a file:

- **Every client file is `.tsx`.** The Worker's existing `tsconfig.json` includes `src/**/*.ts`, which does not match `.tsx`, so the Worker's type program ignores the client entirely and needs no edit. For the same reason `client-env.d.ts` sits at the Worker root and not under `src/` — a `.d.ts` there *would* match.
- **No `.ts` file in the Worker program may import a `.tsx` file.** The seam between a Worker and its client is runtime-only. One import across it pulls the browser build into the Worker's type program, and the rule above stops holding.

### What it wires

Four files are edited.

**An edit touches the lines it means to change, and no others.** Every one of these files is checked into your repository, so the writer prints what the Biome `pithy init` scaffolds would print — short arrays on one line, an object left in whatever shape it already had, comments where you put them. A `pithy ui sync` that adds one path is a one-line diff, and its output passes `biome check` with no formatting step of your own. It did neither before #249: the writer expanded every array in the file, so a two-line change arrived as 78 insertions and then failed the pre-commit hook the CLI itself installed.

**`wrangler.jsonc` — the `assets` stanza.** `not_found_handling` is `"single-page-application"`, and `run_worker_first` is an **explicit allowlist derived from that Worker's composed route table** — never `true`, never a guessed prefix like `/api/*`. Pithy's routes sit at capability base paths (`/auth`, `/leaderboard`, `/payments`, `/storage`, `/media`, …) plus `/health`; nothing lives under `/api`, and an allowlist that assumes otherwise hands `GET /health` the SPA shell. Two derivation rules:

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

**`package.json` — the client dependencies and the scripts that run them.** React, the Vite plugins, and `@pithy-sh/vite`, at the versions listed in `docs/UI.md`. Written at scaffold; `pithy ui` never revisits them. A `@pithy-sh/*` package a linked checkout already provides is left out of `devDependencies` — it resolves without a range, and a range naming a version the registry does not have would break the next install. `devDependencies` in the `--json` result names only what was written, so that run omits it there too.

**The project's root `tsconfig.json` — the client's two programs, appended to `references`.** A program nothing references is a program nothing checks, and `pithy ui add` used to leave exactly that: two tsconfigs beside the Worker's, both invisible to `bun run typecheck`. They are appended after the Worker's own, so `tsc -b` reports in layout order, and a re-run adds nothing. **Extended, never created** — a project scaffolded before `docs/CLI.md` §1.3 existed has Workers whose programs are not `composite`, and `tsc -b` refuses a reference to one of those outright, so writing the file would hand that adopter a typecheck that cannot pass.

### `pithy ui sync`

`run_worker_first` is derived from the route table, and the route table changes whenever a route is mounted: by `pithy add <capability>`, by `pithy remove <capability>`, and by the adopter writing one into their own app capability. **That last one runs no command**, which is how the list goes stale without anyone touching it. `pithy ui sync` re-derives it and rewrites that one key.

`sync` touches nothing else. No file is created, no dependency moves, no scaffolded screen is regenerated. It is idempotent: a run with nothing to change reports that nothing moved.

`--check` writes nothing and reports what the list no longer covers. A shadowed route answers `200 text/html` from the SPA shell with the handler never invoked, and no adopter test suite sees it — tests call handlers directly, so the asset router is never in the picture. So the check exits non-zero and belongs in CI, beside `pithy doctor`:

```
$ pithy ui sync --check --worker api
api: the SPA shell is answering these, not the worker.
  /api/cli/device/start
  /api/organisations
Run pithy ui sync --worker api.
```

A route the allowlist cannot express is never reported: `core`'s own `app.use("*")`, and a route mounted at `/`, are paths the derivation deliberately leaves to the shell (What it wires, above). A check that flagged them would mark every project drifted forever.

## `--json`

One line, one object, one shape per subcommand. The `command` field is the subcommand's dotted name, matching `worker.add` and `feature.create` rather than the space-separated form the resource commands use.

```
$ pithy ui add react --worker api --json
{"command":"ui.add","worker":"api","deployedAs":"pithy-app-api","framework":"react","auth":true,"created":["client-env.d.ts","index.html","src/client.tsx","src/pithy-config.tsx","src/router.tsx","src/routes/app/home.tsx","src/routes/pithy/callback.tsx","src/routes/pithy/otp.tsx","src/routes/pithy/sign-in.tsx","src/session.tsx","src/styles.css","src/turnstile.tsx","tsconfig.client.json","tsconfig.node.json","vite.config.ts"],"skipped":[],"runWorkerFirst":["/auth","/auth/*","/health","/health/*"],"packageManager":"bun","dependencies":["react","react-dom"],"devDependencies":["@cloudflare/vite-plugin","@pithy-sh/vite","@types/react","@types/react-dom","@vitejs/plugin-react","vite"],"scripts":["dev","build","preview"]}
```

`worker` is the `apps/` directory the front end was written into; `deployedAs` is the Worker's deployed script name. **That split holds across every command**, and it is the one thing to know about reading this output: `worker` is what `--worker` accepts and what every path in the same payload is relative to, while `deployedAs` is what the Cloudflare dashboard shows. A run reporting the deployed name (`<project>-<worker>`) beside directory-relative paths described a directory that does not exist, which is what the two fields exist to prevent. `created` and `skipped` are worker-relative and sorted; together they are every file the template declares, so a backfilling run reports the untouched ones rather than staying silent about them. `dependencies`, `devDependencies` and `scripts` name only what this run added.

```
$ pithy ui sync --worker api --json
{"command":"ui.sync","worker":"api","deployedAs":"pithy-app-api","before":["/auth","/auth/*","/health","/health/*"],"after":["/auth","/auth/*","/health","/health/*","/leaderboard","/leaderboard/*"],"changed":true,"uncovered":[],"notFoundHandling":"single-page-application"}
```

`before` and `after` are the allowlist either side of the run, so a CI job can log the delta without recomputing it. `changed` covers everything the call can have moved — the allowlist, or a `not_found_handling` it had to write because the stanza carried none. `uncovered` names the routes the list **in the file** does not cover: always empty after a write, and under `--check` it is the finding, the one thing that fails the exit. `notFoundHandling` is reported because SPA routing depends on it and `sync` does not overwrite a value the adopter chose.

```
$ pithy ui list --json
{"command":"ui.list","stubs":[{"id":"react","description":"React 19 SPA on Vite, served by the worker as static assets"}]}
```

| key | type | meaning |
|---|---|---|
| `command` | string | The subcommand's dotted name: `ui.add`, `ui.sync`, or `ui.list`. |
| `worker` | string | `add`, `sync`. The `apps/` directory the front end was written into, and what every path in the same payload is relative to. |
| `deployedAs` | string | `add`, `sync`. The Worker's deployed script name — what the Cloudflare dashboard shows. |
| `framework` | string | `add`. The stub that was scaffolded. |
| `auth` | boolean | `add`. Whether Pithy's sign-in screens were scaffolded. |
| `created` | string[] | `add`. The files this run wrote, worker-relative and sorted. |
| `skipped` | string[] | `add`. The template's files already on disk, left byte-for-byte alone. |
| `runWorkerFirst` | string[] | `add`. The asset-routing allowlist derived from that Worker's composed route table. |
| `packageManager` | string | `add`. The package manager the scripts were written for. |
| `dependencies` | string[] | `add`. Only what this run added. |
| `devDependencies` | string[] | `add`. Only what this run added. |
| `scripts` | string[] | `add`. Only what this run added. |
| `before` | string[] | `sync`. The allowlist before the run. |
| `after` | string[] | `sync`. The allowlist after it. |
| `changed` | boolean | `sync`. Whether the call moved anything — the allowlist, or a `not_found_handling` it had to write. |
| `uncovered` | string[] | `sync`. The routes the list in the file does not cover. Empty after a write; under `--check` it is the finding. |
| `notFoundHandling` | string | `sync`. Reported because SPA routing depends on it and `sync` does not overwrite a value the adopter chose. |
| `stubs` | object[] | `list`. Each stub's `id` and `description`. |

## Errors

Each one is a `PithyError` — the problem, then the action (`docs/CLI.md` §3.3).

**Unknown framework.**

```
$ pithy ui add svelte --worker api
Unknown UI framework: svelte.
Run `pithy ui add react` — react is the only stub Pithy ships.
```

**A UI is already there.**

```
$ pithy ui add react --worker api
apps/api already has a UI.
Run `pithy ui sync --worker api` to re-derive its asset routing.
```

The check is the manifest's `ui` block, not the presence of files. The stub is scaffolded once; a second `add` would create nothing and imply otherwise.

**`--auth` without the auth capability.**

```
$ pithy ui add react --worker api --auth
apps/api does not compose the auth capability.
Run `pithy add auth --worker api`, then re-run `pithy ui add react --worker api`.
```

**Several Workers, no `--worker`, under `--json`.** The resolution error from 7.2 — the same one `pithy add` raises, naming the Workers it found.

## Examples

```bash
# Scaffold React into the only Worker under apps/, with the sign-in screens.
pithy ui add react --auth

# Re-derive one Worker's asset routing after its capabilities changed.
pithy ui sync --worker api

# The CI gate: write nothing, and fail when the SPA shell is answering a route.
pithy ui sync --check --worker api

# What can be scaffolded.
pithy ui list
```
