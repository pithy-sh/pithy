# pithy dev

Start the local development environment — every Worker in `apps/`, plus each composed capability's host Worker and any front end, under one supervising process.

## Synopsis

```bash
pithy dev [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output. Default `false`. |

## What it does

`pithy dev` runs the whole backend — every Worker in `apps/`, plus any web frontend — under one supervising process, so a developer never hand-juggles terminals or ports. It ports the proven CMS `scripts/dev.ts` design.

- **Discovers workers from `apps/`.** `apps/` *is* the registry — `pithy dev` enumerates `apps/*` (no hand-maintained list) and reads each worker's co-located **`pithy.worker.jsonc`** — a file you own, sitting beside `wrangler.jsonc` (which stays wrangler's) — for its `dev` manifest block: `dev.autostart` (does this worker need to run for the local env to function?), `dev.readySignal` (regex marking "ready" in its output, default `/Ready on https?:\/\//`), an optional `dev.preferredPort`, and an optional `dev.command` (run a non-Worker process — a Vite frontend with no `wrangler.jsonc` — instead of `wrangler dev`). Discovery keys on `pithy.worker.jsonc`, so such a process can join the dev set. It starts exactly the `autostart` workers. Add, remove, or rename a worker with `pithy worker add|remove|rename` and the dev set follows automatically.
- **Runs each composed capability's host Worker too.** `apps/` is the *app* Worker registry; a capability that owns Workflows ships a prebuilt host Worker that `pithy <capability> provision` deploys, and none of them lives in `apps/`. `pithy dev` starts those as well: it reads each app Worker's `pithy.config.ts`, and for every composed capability that owns a host it resolves that capability's committed `wrangler.jsonc` template into a local config under `.wrangler/pithy/hosts/<capability>/` (git-ignored, generated on every run) and starts it. **A host is an ordinary member of the dev set** — its own pinned port from `.dev.config.json`, its own label and colour in the terminal and `logs/dev.log`, its own entry in `.dev-state.json`, reaped with everything else. Adding or removing a capability reconciles the feature's port block exactly the way adding or removing a Worker does. It is registered under the capability's own name, so its siblings reach it at `EMAIL_ORIGIN`, `MEDIA_ORIGIN`, and so on; an `apps/` Worker already using that name is refused rather than silently shadowed. Locally a host binds its databases by binding name — the same names `pithy migrate --env dev` filled — so a first `pithy dev` boots rather than erroring on a missing table. This is why mail sent from localhost now goes somewhere: the app Worker's `EMAIL_SENDER` Workflow named a Worker `pithy dev` did not run, so every enqueued message sat `pending` while the UI reported success.
- **Sends real mail from your machine, and says when it cannot.** The email host's `send_email` binding runs with `remote: true` in `dev` by default, so a magic link you trigger from localhost is delivered through Cloudflare Email Service for real — the same pipeline, the same DKIM, the same delivery logs as production. That needs a Cloudflare login and a sending domain already onboarded. `pithy dev` checks what it cheaply can before spawning anything: with no credentials, or a from address on a domain nobody can onboard, it resolves the host for its local simulator instead, says so with the command that fixes it, and starts the session anyway. The simulator logs the sender, recipient and subject and writes the rendered HTML and text bodies to disk. The verdict is said once, in the ready banner, where a developer looks. The preflight is not the guarantee — a failure that only appears when the binding starts, or at the first send, is caught in the host's own output, rendered as a problem line and an action line, and never kills the session: the host is re-resolved for its simulator on the spot, so the sends that follow are logged and written to disk rather than lost. `email({ devDelivery: "simulator" })` selects the simulator deliberately; every deployed environment always sends for real.
- **Runs a front end as part of the set.** A Worker scaffolded by `pithy ui add` (`docs/commands/ui.md`) does not get a second process. Its `dev.command` replaces `wrangler dev` with Vite, and Vite serves the SPA *and* the Worker on that worker's one pinned port. The command is argv, and the token **`{port}`** in any argument is substituted with that port at spawn time: `["bun", "x", "vite", "dev", "--configLoader", "runner", "--strictPort", "--port", "{port}"]` runs as `bun x vite dev --configLoader runner --strictPort --port 8787`. `{port}` is the only token substituted.
- **Supervises N workers.** Spawns each autostart worker, labels and colorizes their interleaved output, and tees everything to the terminal *and* `logs/dev.log`. A single "ready" banner prints once every started worker matches its `dev.readySignal`.
- **Names a worker that starts and never becomes ready.** A child that never matches its `dev.readySignal` is still a *live* child. `wrangler dev` does not exit when a build fails — it prints the error and keeps running — and the same shape covers a startup that hangs, a port that never binds, and a `dev.command` process that comes up wrong. The banner waits on the whole set, so it never fires, and the session used to proceed looking healthy with the real error forty lines up the scrollback. 90 seconds after the last worker is spawned, `pithy dev` says `Still waiting on: support.` — every worker still missing, by name — and repeats the line every 30 seconds while it stays true, because one line at the deadline scrolls away exactly like the error did. The clock starts at the spawn, not at the command: everything before it — `.dev.vars`, the host configs, the previous session, the orphan sweep, both loopback families of every pinned port, the dev secrets — is tens of seconds on a cold project, and none of it is a worker being slow. It is *still waiting*, not *failed*: the first `wrangler dev` of a session pays for a cold bundle, and a slow worker is not a broken one. A worker that arrives late drops out of the next line on its own, and the banner fires as it always would. **A worker that never arrives is reported, never killed** — one child exiting tears the whole session down, and stopping every healthy worker over one worker's typo is a worse trade than a line naming it. The report names the mechanism, never a cause it cannot know: the worker is still running, so nothing else in the session was going to mention it, and its own output above says why. It names a restart because a `wrangler dev` whose *first* build fails never rebuilds — fixing the file and waiting is the one thing that cannot work. Under `--json` the report is a record rather than a sentence (`--json`, below).
- **Resolves ports safely.** Each worker's start port is the one pinned in the worktree's port block (Per-feature ports, below), verified — never probed. A port is used only if free on **both** `127.0.0.1` and `::1` (Vite binds IPv6-only, wrangler binds both); if a pinned port is taken, the orchestrator reports a conflict and stops, rather than silently drifting to another port and breaking the sibling workers that were told its address ahead of time.
- **Wires workers to each other over localhost.** Resolved ports are exported as env and the cross-worker URLs are baked in as `*_ORIGIN` dev vars, so workers call each other directly — never relying on wrangler's flaky cross-`wrangler dev` service registry.
- **Generates every worker's `.dev.vars`.** wrangler loads a `.dev.vars` from the directory it runs in and merges nothing, so each `apps/<worker>/` needs its own file — and each one is written here, from sources that never leave your machine: every `cf-secrets-store` secret your registry declares, read straight from `<config>/<project>/secrets.jsonc`, plus whatever in `<config>/<project>/dev.json` no registry declares, overridden by the repo's root `.dev.vars.local`, overridden in turn by that worker's own. **The dev secrets file is the source, not a file something copies out of**: edit a value there and the next `pithy dev` hands the Worker the new one, with no `pithy seed` in between; delete one and it is gone from every generated file, with no stale copy anywhere to fall back to. There is nothing to inherit and nothing to wire. `pithy init` writes no `.dev.vars` at all, a clone has none, and `pithy dev` is the command that runs every time — unlike a `postinstall`, which runs before the values exist. Each generated file opens with a marker, and **a `.dev.vars` pithy did not write is never overwritten and never merged**: it is named, with `.dev.vars.local` offered as the place for local values, and that worker starts without one rather than with somebody else's file replaced underneath it. Idempotent by comparing content, never mtime — a second run writes no bytes, so wrangler's watcher has nothing to react to. The ordinary run says nothing; a refusal gets a sentence, and so does a worker whose `.dev.vars` was still a symlink from the design this replaced. Non-fatal in every direction: a worker that could not be written is named, and every other worker still starts.

### Signing in: press `l`

`pithy seed` can mint a real, signed-in session for a seeded user (`docs/commands/seed.md`). `pithy dev` is where you use it.

- **The ready banner names the user, and nothing else.** `Dev login: ada@example.com — press l to open a signed-in browser.` **No session cookie is ever printed**, to the terminal or to `logs/dev.log`. It used to be — a `document.cookie = "…"` line to paste into a browser console — and a working session token rendered as text is a working session token at rest in a scrollback, a log, and a screenshot. The value now travels from the Worker to the browser over HTTP and lands nowhere else.
- **`l` opens the browser you already use.** It opens `http://localhost:<port>/__pithy/dev-login` with the platform's own opener (`xdg-open`, `open`, `start`) — no browser automation, so it works in whatever browser is default, from a second profile, and from an incognito window. That route sets the cookie and redirects to `/`. Reload nothing; you are signed in.
- **The route exists only in a `dev` composition, and never under CI.** `@pithy-sh/auth` registers `GET /__pithy/dev-login` behind two independent gates, both at registration rather than inside the handler: the composition's `ENVIRONMENT` must be `dev`, **and** `CI` must be unset or blank. A `staging` or `prod` Worker does not carry the route at all, and neither does a `dev` Worker started by a CI job. It mints an authenticated session with no credential presented, so neither gate is allowed to imply the other. (`pithy dev` forwards `CI` into each Worker as a var, because the host environment does not otherwise cross into workerd.)
- **Which Worker.** The candidates are the started Workers that compose auth — a cookie is scoped to the origin that set it, so no other origin can be signed in by opening it. With one candidate, `l` opens it. With several, the one carrying a front end (`ui` in its `pithy.worker.jsonc`) wins; if that does not decide, `pithy dev` prints the choices rather than guessing.
- **No seeded session.** `l` says so and names `pithy seed`. It never opens a URL that 404s. An expired session is treated the same way, with the same command.
- **No terminal, no keypress.** A piped `pithy dev`, and any run in CI, never enters raw mode and never waits for input — the banner prints the URL instead. `--json` starts no key handling at all. Ctrl-C stops the session exactly as it always did.
- Bound today: `l`. Nothing else.

### Session state and cleanup

- Writes a git-ignored `.dev-state.json` (pid, resolved ports, child pids).
- A re-run stops the previous session first, then **reaps orphaned `workerd`/`wrangler`** processes still holding the default ports (an `lsof` sweep) so a crashed session can't block startup.
- Children are spawned via `setsid` so one `kill(-pgid)` tears down the whole `wrangler → workerd` subtree. Teardown is graceful `SIGTERM`, then `SIGKILL` after a short grace window.

### Per-feature ports (run many worktrees at once)

Port collisions are the one thing that stops two feature worktrees running simultaneously — and, since every project starts at the same base port, two *projects* as readily as two worktrees. The fix is a **central registry that every feature reads before it assigns**, held once per machine rather than once per checkout, so a new feature sees everything already taken on the machine and can't collide with any of it.

- **The registry** is a single **`dev-ports.json`** in the Pithy config directory — `$PITHY_CONFIG_DIR`, else `%APPDATA%\pithy` on Windows, else `$XDG_CONFIG_HOME/pithy`, else `~/.config/pithy`. **One file for the whole machine, not one per checkout.** It used to sit at the main repo root, which meant every project on a machine kept its own, every one of them started empty, and every one of them handed out block 0 — so two projects on their default branch pinned the same twenty ports. `pithy doctor` prints the resolved path on every run, because nothing in your project mentions it.

  It's keyed by **main-checkout root**, then by branch, each value the contiguous block that branch owns:

  ```json
  {
    "/home/jo/code/acme": {
      "main":             { "block": 0, "base": 8787, "size": 20 },
      "feature/12-auth":  { "block": 1, "base": 8807, "size": 20 }
    },
    "/home/jo/code/other-app": {
      "main":             { "block": 2, "base": 8827, "size": 20 }
    }
  }
  ```

  The key is the checkout, not the project `name`: two unrelated projects can share a name, and sharing a name must never mean sharing ports. A worktree resolves its own root from anywhere via `git rev-parse --git-common-dir`, so every worktree of one repository files under one key.
- **A checkout that is gone frees its ports.** At the repo root the registry died with the checkout, so `rm -rf` cleaned up for nothing. In the config directory nothing would, so every allocation prunes — under the same lock — any root no longer on disk. Only a definite "not there" counts: a root the CLI merely could not reach keeps its blocks. It cannot tell a deleted checkout from a **moved** one, and does not try: a moved repository's blocks are freed, and it takes them back the next time `pithy dev`, `pithy feature create` or `pithy feature sync` runs in it, since its worktrees still pin them. Between those two moments another project can be handed one — again as a reported port conflict, not a silent double-bind.

- **`pithy feature create`** takes a short file lock, reads the registry (seeing every block already in use), assigns the **lowest free, non-overlapping block**, writes its key, and unlocks. One atomic read-modify-write — no two features can pick the same block.
- **`pithy feature destroy`** (and merge-to-`main` cleanup) deletes its key, returning the block to the pool. Add/remove is a single keyed mutation; no per-branch files to orphan.
- **Each worktree** also gets a git-ignored **`.dev.config.json`** — the feature's own dev configuration, written at creation and **fixed for the life of the feature**. It records the reserved block and pins **one port per worker**:

  ```json
  {
    "version": 1,
    "branch": "feature/12-auth",
    "ports": { "index": 0, "base": 8787, "size": 20 },
    "workers": {
      "api": { "port": 8787, "origin": "http://localhost:8787" },
      "web": { "port": 8788, "origin": "http://localhost:8788" }
    }
  }
  ```

  `pithy dev` reads it as its start ports, and every worker's address is known ahead of time, so the workers auto-wire to each other. (Distinct from `.dev-state.json`, the running session's pid/child-pids from Session state and cleanup, above.) It is named for the feature's dev config, not for ports alone, so further per-feature dev settings land here without a rename.
- **Ports are assigned at creation, never probed at startup.** Probing when a worker boots is a time-of-check/time-of-use race: two `pithy dev` processes in two worktrees can both observe the same port free and both try to bind it. Pre-assigning every worker its own port from a reserved block removes the race by construction — N features start simultaneously with nothing to negotiate.
- **Per-feature values never go in `.dev.vars`.** That file is generated (above), so a value typed into it is gone on the next `pithy dev` — and the sources it is generated from are keyed on the project and held on the machine, which means every worktree of one project resolves the same ones. A per-feature value put there would clobber every other feature's. Shared secrets live in the dev secrets file; per-feature ports live in `.dev.config.json`.
- `pithy dev` still verifies each assigned port is actually free (IPv4 + IPv6) before starting, and **reports a conflict rather than drifting** if something external grabbed one — a worker that quietly moves breaks every sibling that was told its address at creation. Because blocks are disjoint and stable, multiple worktrees run in unison and each feature's workers reach each other on their assigned localhost ports.

> **Why one keyed registry, not a file per branch** (`dev-ports.<branch>.json`)? A single file shows every allocation on the machine in one read, makes add/remove a one-key mutation, and leaves no stale per-branch files to garbage-collect. File-per-branch works but forces a glob-and-read-all to see what's taken — and it is exactly the glob that a second project would have started over from.

- **Adding a worker is additive.** Port assignment is *sticky*: a worker that already holds a port keeps it, and only genuinely new workers are assigned, each taking the lowest free port in the block. Discovery is alphabetical, so a purely positional assignment would renumber every later worker the moment someone added one that sorts earlier — moving addresses out from under a running session. A removed worker releases its port back to the block.
- **The registry is self-healing.** It sits outside every checkout, so no clone and no `git clean` can take it — but a wiped config directory, a new machine, or a relocated `$PITHY_CONFIG_DIR` still can, while the worktrees allocated from it live on. Before allocating, `pithy feature create` reclaims any block still pinned in an existing worktree's `.dev.config.json`, so a lost registry cannot hand out a block a live feature is using. **Within that checkout** — the scan walks the `.worktrees/` of the repository the command was run in, and it does not go looking through the others the registry knew about. So after a wipe, each project re-registers its own the next time `pithy dev` starts there — every worktree's pinned block, and the checkout's own — and a project that has not run since the wipe can be handed one of its blocks by one that has. `pithy dev` verifies each port on both stacks before binding and reports the conflict, so it surfaces as a refusal rather than two Workers on one port.

**`pithy feature sync`** — run from the worktree, no arguments, the branch says which feature it is. It makes the local environment ready whatever state it is in, and covers the two everyday cases with one command:

- **You added a worker.** It takes the next free port from the feature's already-reserved block and leaves every existing worker exactly where it was.
- **A colleague pushed the branch and you pulled it.** None of the local state is in git — `.dev.config.json` and the port reservation are both machine-local — so sync creates them on *your* machine, with your own free block, and migrates + seeds your local backend. (This is precisely why ports are never committed: your teammate's block may already be taken on your machine by one of your other worktrees — or by another project entirely.) It touches no `.dev.vars`: each worker's is generated by `pithy dev` from sources that were already on your machine, so there is nothing here to share and nothing to lose.

Every step is idempotent, so running it when nothing is missing reports that nothing moved. `--skip-data` reconciles ports without touching the backend.

#### Naming and wiring a feature's live environment

The same branch-first identity that names a feature's D1/KV/R2 resources also names its **Workers**, so a feature environment is fully self-wiring in CI:

```
<project>-f<issue>-<slug>-<worker>     acme-f69-media-cli-api      (Worker script)
<project>-f<issue>-<slug>-<binding>-<kind>   acme-f69-media-cli-db-d1    (D1)
```

`pithy provision --feature` writes into each Worker's config, under `env.<env>`:

- **`name`** — the script name that Worker deploys under for the feature, so a preview deploy never overwrites production's.
- **`services[]`** — every `service` binding retargeted at the *feature's* copy of the callee. A capability declares the target Worker on the binding (`{ type: "service", name: "API", service: "api" }`); the CLI resolves `api` to `acme-f69-media-cli-api`. Worker-to-worker RPC therefore stays inside the feature environment instead of reaching production.

**Nothing is stored or committed to make this work.** Every name is derived from the branch, and an already-provisioned resource's id is recovered by looking that name up in Cloudflare — which is exactly what makes `provision` idempotent. On a second push, CI computes the same names, finds the existing D1/KV/R2, rewrites the same wiring, and deploys. There is no id file to merge, so there is nothing to conflict.

A feature environment *is* an environment, so `f<issue>-<slug>` simply occupies the environment slot of the one project-scoped rule every other name follows (`docs/NAMING.md`).

**This is the tightest shape Pithy composes, and it is the shape that caps the project name.** Held to R2's 63 characters, with 7 taken by the fixed literals — `-f`, three more hyphens, and the two-character kind — the four variable segments divide 56 between them: `project + issue + slug + binding = 56`. The issue number is reserved 6 digits, so a 12-character project with a `DB` binding leaves 36 characters of slug at a 6-digit issue, and 40 at a real 2-digit one. A slug over budget is truncated to a head plus a six-hex hash rather than refused — a feature name addresses nothing that outlives the feature, and failing CI over a long branch name would be the worse failure — but a hashed slug tells nobody reading a bucket listing which branch owns it. Keep the part of the branch name after the issue number to roughly 20 characters. `docs/NAMING.md` has the budget worked out per project length.

`<project>` is `pithy.config.ts`'s `name` — required for `pithy feature` naming, with no guessed fallback. `resolveProjectName`'s lenient guesses (an app Worker's `wrangler.jsonc` name, the project directory's basename) are not stable across machines and checkouts, and teardown has no record of a resource beyond its computed name: a wrong guess means `pithy feature destroy` computes names that match nothing, deletes nothing, and exits 0. Set `name` in `pithy.config.ts`; a project without one gets an actionable error the first time a feature command needs it.

### Voice

All `pithy dev` output obeys the brand voice (`docs/CLI.md` §3 / `BRAND.md` §5): labeled lines, deliberate periods, no celebration. The ready banner is information, not confetti.

## `--json`

**Every line on stdout is one object.** The session keeps running, so a script reads `pithy dev --json` line by line rather than waiting for it to end.

Everything said to a person moves to stderr under `--json` — the `Starting …` line, the delivery verdict, a `.dev.vars` refusal, and the workers' own output, which is the bulk of the stream and every line wrangler and Vite print. It used to share stdout with the JSON, so `pithy dev --json | jq` choked on the first thing wrangler said and a consumer's only rule was to try each line and skip whatever failed to parse — which skips a JSON line we get wrong just as quietly. Splitting by descriptor costs a person nothing: both halves still reach the terminal, and `logs/dev.log` carries the lot in either mode. A run that stops on an error writes the `{"error": …}` line to stderr, as every `pithy` command does.

### The session line

Written as soon as every worker is started. It is what tells a script where the workers are.

```json
{"command":"dev","workers":{"api":{"port":8787,"origin":"http://localhost:8787"},"web":{"port":8788,"origin":"http://localhost:8788"}}}
```

| key | type | meaning |
|---|---|---|
| `command` | string | `"dev"`. |
| `workers` | object | One entry per started worker, keyed by its name. |
| `workers.<name>.port` | number | The port that worker was assigned in `.dev.config.json`, verified free before it started. |
| `workers.<name>.origin` | string | The localhost address its siblings were told to call it on. |

Those four keys are the whole session line. In particular it carries **no dev-login field**: the ready banner is suppressed under `--json`, no key handling starts, and a session cookie has no business in a machine-readable line any more than in a human-readable one. A script that wants the dev login builds the URL from an origin above and `/__pithy/dev-login`.

### The still-waiting line

Written 90 seconds after the last worker is spawned, and every 30 seconds after that, while any worker has started and not become ready (What it does, above). Not written at all when every worker arrives in time.

```json
{"command":"dev","event":"still-waiting","waiting":["support"]}
```

| key | type | meaning |
|---|---|---|
| `event` | string | `"still-waiting"`. What distinguishes this line from the session line above. |
| `waiting` | array of string | The workers that have started and not matched their `dev.readySignal` yet, in start order. Read afresh at every report, so a worker that arrives late is gone from the next one. |

**Why the session line cannot carry this.** It is written the moment the children are spawned, and readiness is decided after it — a run whose `support` worker cannot build emits exactly the same session line as a healthy one. Without this second line, an agent driving `pithy dev --json` sits in the position `#426`'s adopter was in: a session that never says it is ready and nothing on the wire naming what is missing. The prose report is not on stdout under `--json` — it goes to stderr and to `logs/dev.log`, both read by a person in either mode.

## Errors

`pithy dev` supervises, so most of what can go wrong is reported and survived rather than thrown.

- **A pinned port is taken.** The run reports the conflict and stops. It never drifts to another port: a worker that quietly moves breaks every sibling that was told its address at creation.
- **A `.dev.vars` pithy did not write.** Never overwritten and never merged. The file is named, `.dev.vars.local` is offered as the place for local values, and that worker starts without one.
- **A worker whose `.dev.vars` could not be written.** Named, and every other worker still starts.
- **A worker exits.** The rest come down with it. `SIGINT` or `SIGTERM` tears the whole session down the same way — graceful `SIGTERM`, then `SIGKILL` after a short grace window.
- **`l` with no browser to open.** A machine with no `xdg-open` gets one line naming the URL to open by hand. The session keeps running: no browser is not a reason to stop supervising workers.

## Examples

```bash
# Start every autostart worker under apps/.
pithy dev

# The same, reporting each worker's resolved port and origin as one line of JSON.
pithy dev --json
```
