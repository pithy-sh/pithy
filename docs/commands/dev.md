# pithy dev

_The site renders this for readers: [pithy.sh/docs/cli/commands/dev](https://pithy.sh/docs/cli/commands/dev). This page is the specification it renders — `packages/cli/src/commands/doctorDocs.test.ts` and `packages/cli/src/dev/readyWatchDocs.test.ts` hold the code to it — so it stays here._

Start the local development environment — every Worker in `apps/`, plus each composed capability's host Worker and any front end, under one supervising process.

## Synopsis

```bash
pithy dev [--app <name>]… [--json]
pithy dev --list [--app <name>]… [--json]
```

## Flags

| Flag | Meaning |
|---|---|
| `--list` | Print the set a run right now would start — every `apps/` Worker and every capability host, marked by kind and carrying the port it would be pinned to. Starts nothing and writes nothing. Honors `--app`. Default `false`. |
| `--app <name>` | Start exactly the worker named, whatever this branch has turned off. **Repeatable** — the raw argv is read, so several survive. A name is the deployed name, the `apps/<dir>` basename, or a capability name for a host. Literal: naming a worker pulls in no capability host. An unknown name refuses the whole run before anything spawns, naming the valid set. |
| `--disable-autostart` | Stop `--app`'s workers starting on this branch, on this machine. Writes `dev-ports.json` and **starts nothing**. Default `false`. |
| `--enable-autostart` | Undo `--disable-autostart` for `--app`'s workers. Removes the key rather than storing `true`. Starts nothing. Default `false`. |
| `--tui` / `--no-tui` | Render the live roster at a terminal, or don't. Default `true`. `--no-tui` gives the plain stream — every line the roster would have superseded, and no repainting region. **Neither form overrides a pipe, `--json`, `CI` or `TERM=dumb`**: those have no terminal to draw on or a consumer parsing the output, so they are plain regardless. `PITHY_NO_TUI` set to any non-blank value does the same thing as a standing preference, and a typed `--tui` beats it for one run — the same reading `--app` takes over this branch's autostart answer. |
| `--json` | Machine-readable output. Default `false`. |

## What it does

`pithy dev` runs the whole backend — every Worker in `apps/`, plus any web frontend — under one supervising process, so a developer never hand-juggles terminals or ports. It ports the proven CMS `scripts/dev.ts` design.

- **Discovers workers from `apps/`.** `apps/` *is* the registry — `pithy dev` enumerates `apps/*` (no hand-maintained list) and reads each worker's co-located **`pithy.worker.jsonc`** — a file you own, sitting beside `wrangler.jsonc` (which stays wrangler's) — for its `dev` manifest block: `dev.readySignal` (regex marking "ready" in its output, default `/Ready on https?:\/\//`), an optional `dev.preferredPort`, and an optional `dev.command` (run a non-Worker process — a Vite frontend with no `wrangler.jsonc` — instead of `wrangler dev`). Discovery keys on `pithy.worker.jsonc`, so such a process can join the dev set. **Every worker starts.** The manifest has no say in it: `dev.autostart` was removed, because which workers one developer is exercising this week is not a fact about the project and did not belong in a committed file. See [Keeping a worker out of your dev set](#keeping-a-worker-out-of-your-dev-set). Add, remove, or rename a worker with `pithy worker add|remove|rename` and the dev set follows automatically.
- **Runs each composed capability's host Worker too.** `apps/` is the *app* Worker registry; a capability that owns Workflows ships a prebuilt host Worker that `pithy <capability> provision` deploys, and none of them lives in `apps/`. `pithy dev` starts those as well: it reads each app Worker's `pithy.config.ts`, and for every composed capability that owns a host it resolves that capability's committed `wrangler.jsonc` template into a local config under `.wrangler/pithy/hosts/<capability>/` (git-ignored, generated on every run) and starts it. **A host is an ordinary member of the dev set** — its own pinned port from `.dev.config.json`, its own label and color in the terminal and `logs/dev.log`, its own entry in `.dev-state.json`, reaped with everything else. Adding or removing a capability reconciles the feature's port block exactly the way adding or removing a Worker does. It is registered under the capability's own name, so its siblings reach it at `EMAIL_ORIGIN`, `MEDIA_ORIGIN`, and so on; an `apps/` Worker already using that name is refused rather than silently shadowed. Locally a host binds its databases by binding name — the same names `pithy migrate --env dev` filled — so a first `pithy dev` boots rather than erroring on a missing table. This is why mail sent from localhost now goes somewhere: the app Worker's `EMAIL_SENDER` Workflow named a Worker `pithy dev` did not run, so every enqueued message sat `pending` while the UI reported success.
- **Sends real mail from your machine, and says when it cannot.** The email host's `send_email` binding runs with `remote: true` in `dev` by default, so a magic link you trigger from localhost is delivered through Cloudflare Email Service for real — the same pipeline, the same DKIM, the same delivery logs as production. That needs a Cloudflare login and a sending domain already onboarded. `pithy dev` checks what it cheaply can before spawning anything: with no credentials, or a from address on a domain nobody can onboard, it resolves the host for its local simulator instead, says so with the command that fixes it, and starts the session anyway. The simulator logs the sender, recipient and subject and writes the rendered HTML and text bodies to disk. The verdict is said once, in the ready banner, where a developer looks. The preflight is not the guarantee — a failure that only appears when the binding starts, or at the first send, is caught in the host's own output, rendered as a problem line and an action line, and never kills the session: the host is re-resolved for its simulator on the spot, so the sends that follow are logged and written to disk rather than lost. `email({ devDelivery: "simulator" })` selects the simulator deliberately; every deployed environment always sends for real.
- **Authenticates every worker as your project's Cloudflare account, not your shell's.** A `wrangler dev` with a remote binding reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` out of its own environment, so `pithy dev` resolves the account this project claims — `<config>/cloudflare.json`, or `cloudflare.<name>.json` when the root `pithy.config.ts` names one — and overlays that pair onto every child it starts. If your shell happens to hold credentials for a different account, the session says so once at startup and uses the project's; `wrangler whoami` will disagree, and the project's is the one that counts. A `cloudflare.accountId` the resolved credentials contradict is refused before any worker spawns rather than discovered later by a send that silently fails. Under `PITHY_OFFLINE` the children are handed no credentials at all, which is what that switch is for.

- **Runs a front end as part of the set.** A Worker scaffolded by `pithy ui add` (`docs/commands/ui.md`) does not get a second process. Its `dev.command` replaces `wrangler dev` with Vite, and Vite serves the SPA *and* the Worker on that worker's one pinned port. The command is argv, and the token **`{port}`** in any argument is substituted with that port at spawn time: `["bun", "x", "vite", "dev", "--configLoader", "runner", "--strictPort", "--port", "{port}"]` runs as `bun x vite dev --configLoader runner --strictPort --port 8787`. `{port}` is the only token substituted.
- **Supervises N workers.** Spawns each worker in the started set — every worker this branch has not turned off, or exactly what `--app` names — labels and colorizes their interleaved output, and tees everything to the terminal *and* `logs/dev.log`. A single "ready" banner prints once every started worker matches its `dev.readySignal`.
- **Names a worker that starts and never becomes ready.** A child that never matches its `dev.readySignal` is still a *live* child. `wrangler dev` does not exit when a build fails — it prints the error and keeps running — and the same shape covers a startup that hangs, a port that never binds, and a `dev.command` process that comes up wrong. The banner waits on the whole set, so it never fires, and the session used to proceed looking healthy with the real error forty lines up the scrollback. 90 seconds after the last worker is spawned, `pithy dev` says `Still waiting on: support.` — every worker still missing, by name — and repeats the line every 30 seconds while it stays true, because one line at the deadline scrolls away exactly like the error did. The clock starts at the spawn, not at the command: everything before it — `.dev.vars`, the host configs, the previous session, the orphan sweep, both loopback families of every pinned port, the dev secrets — is tens of seconds on a cold project, and none of it is a worker being slow. It is *still waiting*, not *failed*: the first `wrangler dev` of a session pays for a cold bundle, and a slow worker is not a broken one. A worker that arrives late drops out of the next line on its own, and the banner fires as it always would. **The deadline outlives the banner.** A worker restarted with `r` has started and is not ready, so it is named on the same schedule; a session that had been ready once used to fall silent instead. One restarted while the session is still coming up inherits the clock already running, so pressing `r` never restarts the clock for the siblings still waiting. **A worker that never arrives is reported, never killed** — one child exiting tears the whole session down, and stopping every healthy worker over one worker's typo is a worse trade than a line naming it. The report names the mechanism, never a cause it cannot know: the worker is still running, so nothing else in the session was going to mention it, and its own output above says why. It names a restart because a `wrangler dev` whose *first* build fails never rebuilds — fixing the file and waiting is the one thing that cannot work. Under `--json` the report is a record rather than a sentence (`--json`, below).
- **Resolves ports safely.** Each worker's start port is the one pinned in the worktree's port block (Per-feature ports, below), verified — never probed. A port is used only if free on **both** `127.0.0.1` and `::1` (Vite binds IPv6-only, wrangler binds both); if a pinned port is taken, the orchestrator reports a conflict and stops, rather than silently drifting to another port and breaking the sibling workers that were told its address ahead of time.
- **Wires workers to each other over localhost.** Resolved ports are exported as env and the cross-worker URLs are baked in as `*_ORIGIN` dev vars, so workers call each other directly — never relying on wrangler's flaky cross-`wrangler dev` service registry.
- **Generates every worker's `.dev.vars`.** wrangler loads a `.dev.vars` from the directory it runs in and merges nothing, so each `apps/<worker>/` needs its own file — and each one is written here, from sources that never leave your machine: every `cf-secrets-store` secret your registry declares, read straight from `<config>/<project>/secrets.jsonc` and written under the binding the Worker reads it through (`email-link-signing-key` as `EMAIL_LINK_SIGNING_KEY`; two Workers whose secrets derive one binding get neither, and the run names both), plus whatever in `<config>/<project>/dev.json` no registry declares, overridden by the repo's root `.dev.vars.local`, overridden in turn by that worker's own. **The dev secrets file is the source, not a file something copies out of**: edit a value there and the next `pithy dev` hands the Worker the new one, with no `pithy seed` in between; delete one and it is gone from every generated file, with no stale copy anywhere to fall back to. There is nothing to inherit and nothing to wire. `pithy init` writes no `.dev.vars` at all, a clone has none, and `pithy dev` is the command that runs every time — unlike a `postinstall`, which runs before the values exist. Each generated file opens with a marker, and **a `.dev.vars` pithy did not write is never overwritten and never merged**: it is named, with `.dev.vars.local` offered as the place for local values, and that worker starts without one rather than with somebody else's file replaced underneath it. Idempotent by comparing content, never mtime — a second run writes no bytes, so wrangler's watcher has nothing to react to. The ordinary run says nothing; a refusal gets a sentence, and so does a worker whose `.dev.vars` was still a symlink from the design this replaced. Non-fatal in every direction: a worker that could not be written is named, and every other worker still starts.

### Listing the set

`pithy dev --list` prints the set a run right now would start, and starts nothing.

- **Every member, both halves.** The `apps/` Workers and each composed capability's host Worker, each marked by kind. `pithy worker list` cannot answer this: it enumerates `apps/`, which is the registry, and a host is resolved from the composition rather than from a directory. Two commands, two questions — the registry view and the run view.
- **Each carrying the port it would be pinned to.** Read from `.dev.config.json`, and for a worker added since the last run, computed the way the next run computes it — not guessed. A project that has never run `pithy dev` shows `—` for every port: assigning one is a run's job, and a listing that invented an address nothing had reserved would be a lie.
- **It honors `--app`.** `pithy dev --list --app board` still lists everything and marks what that selection would start, so it answers *what would that actually give me* before you commit to it.
- **It writes nothing.** No `.dev.config.json`, no `.dev.vars`, no host config under `.wrangler/pithy/hosts/`, no `logs/dev.log`, no `.dev-state.json`. Nothing is spawned and no port is bound to test it.
- **What it cannot know.** Which hosts actually come up is settled only once their configs are written, which is a run's work — so a host whose template will not resolve is listed here and dropped by the run, which says so at the time.

### Starting part of it: `--app`

`pithy dev --app <name>` starts exactly the workers it names, whatever this branch has turned off. Naming a worker is the more specific act, and that is the flag's whole purpose.

- **Repeatable.** `pithy dev --app api --app web`. The raw argv is read, because citty keeps only the last occurrence of a repeated string flag.
- **Three name forms.** The deployed name, the `apps/<dir>` basename, or a capability name for a host — so `pithy dev --app email` runs the email host on its own. The deployed name is tried first: a Worker in `apps/email/` deployed as `acme-email` can sit beside the `email` capability host, and there `email` means the host while `acme-email` means the Worker. The deployed name leads because it is the key `.dev.config.json`, `.dev-state.json` and `<CAPABILITY>_ORIGIN` are all written under.
- **Literal.** No composed host comes along for the ride. `--app board` gives you `board`, with `EMAIL_ORIGIN` pointing at something that is not running, and that is the answer you asked for: a developer narrowing the dev set knows what they are narrowing.
- **Validated before anything spawns.** One unknown name refuses the whole run and names the valid set. So does a `--app` with nothing after it — an empty selection means *start everything*, so a forgotten name would spawn the estate. Nothing half-starts and then dies.
- **It never changes what a worker's port is.** Ports are pinned per worker for the life of the feature and are computed over every discovered member, not over what happens to be running — so a run of one hands that one worker exactly the port a run of all of them would, and the run after it finds every address where it left it.

### Keeping a worker out of your dev set

```bash
pithy dev --app payments --disable-autostart   # stop it starting on this branch
pithy dev --app payments --enable-autostart    # let it start again
```

Both write and **start nothing**.

Whether a worker starts locally is not a fact about the project. `pithy.worker.jsonc` is committed and the same for everyone: it says a worker exists and how it is run. Which workers *you* are exercising this week is yours. So the answer lives beside your port block in `dev-ports.json`, keyed on the same three things the block is — **this checkout, this branch, this machine** — and nothing about it is committed or shared. `dev.autostart` was removed for exactly this reason.

- **Every worker autostarts.** No entry, no `autostart` map, or no name in the map all mean the same thing: it starts. There is no state where the file's silence has to be interpreted.
- **`--app` is above it.** `pithy dev --app payments` still starts a worker you have turned off, for that one run, without turning it back on. Naming a worker outright is the more specific act.
- **Per branch, inherited once.** `pithy feature create` copies the branch it cut from, so a worker you parked on `main` stays parked in the new feature rather than quietly coming back. It is a copy, so from then on the two disagree freely — change it in a worktree and you change that feature; change it on `main` and you change `main`. `pithy feature sync` never reimposes `main`'s answer on a feature that has since changed its own, and `pithy feature destroy` takes the feature's answer with the branch.
- **`--enable-autostart` removes the key** rather than storing `true`, so the file never grows a row per worker per branch for every worker somebody turned off and on again.
- **Names resolve exactly as a run resolves them** — the deployed name, the `apps/<dir>` basename, or a capability name for a host. An unknown name is refused before anything is written. A capability host can be turned off too: that is an explicit act by somebody who knows its Workflows will not run.
- **Ports are untouched.** Turning a worker off changes nothing about what any worker is pinned to.

`pithy dev --list` marks such a worker `skipped  off here`, and `pithy worker list` reports it separately from the manifest, so you are never sent to a committed file to undo something that is not written there.

**A leftover `dev.autostart` in a manifest:** `true` is accepted and ignored — `pithy worker add` wrote it into every manifest it ever scaffolded, and it agrees with the answer. `false` is **refused**, naming the command above, because it is the one value somebody chose and silently dropping it would start a worker its owner had turned off.

### The live roster

At a real terminal, `pithy dev` pins a roster under the session's output and keeps it current. Every worker, its kind, its port, its state, and how long it took.

```
──────────────────────────────────────────────────────────────────
  worker      kind    port   state      time    autostart
▸ api         app     8787   ready      1.9s    on
  web         app     8788   ready      2.4s    on
  email       worker  8789   ⠋ building  14s     on
  support     worker  8790   waiting     2m14s   on
  payments    worker  8791   skipped            off
──────────────────────────────────────────────────────────────────
  ↑↓ select   r restart   o open   f logs (F all)   a autostart off   l login   q quit
```

- **Worker output is hidden until you ask for it.** The roster is the point — five workers' startup chatter is what used to bury it — so by default the stream carries the session's own narration and nothing else: a `.dev.vars` refusal, the delivery verdict, `Still waiting on: …`, `l`'s identity list, and the log path. (`Starting …` and `Ready.` are left out too — see below — because the roster says both.) Press `f` for the selected worker's output, or `F` for all of it. Everything goes to `logs/dev.log` either way, whether you ever reveal it or not.
- **A worker in trouble reveals itself.** Hiding output must not bury the thing you came for, so a worker that exits, or that is still missing at the ready deadline, has its output shown without being asked — along with the last 200 lines it produced while hidden. Quiet when healthy, loud when not.
- **What you reveal is shown in its own color.** A revealed worker's name on the roster is painted the same color `[api]` carries in the stream, so the rows whose color you can see are the rows whose output you can see.
- **The output above the roster is unchanged.** Each line is written once, to the terminal, and never redrawn — so your own scrollback, selection and copy work exactly as they always did, and a line longer than the window soft-wraps the way the terminal wraps it rather than being broken in half. Only the roster repaints.
- **The ready banner shrinks to what the roster cannot say.** Its `name: http://localhost:####` list, its `Starting …` line, its `Ready.` and its `Dev login:` line are all facts the table and its key bar hold a line below, so none of them is printed. What remains is the delivery verdict and the log path: the first because no row carries it, the second because hidden output makes it matter more. `logs/dev.log` records every one of them as it always did. Without a roster — piped, `--json`, CI — the banner is unchanged, because there it is the only place the addresses appear.
- **A parked worker still gets a row**, marked `skipped` with `autostart` reading `off`, carrying the port it would be pinned to. `pithy dev --list` has always named it; the roster is where you can act on it, and `r` on that row *starts* it rather than restarting it. A capability worker parked this way has its generated config written at that moment, since a run only materializes the hosts it starts.
- **The key bar sheds the marker hint before it sheds anything else.** At a width that cannot fit the whole bar it drops `↑↓ select` — arrows beside a visible marker are the one hint that explains itself — and only a genuinely narrow terminal collapses it to `? keys`.
- **There is a header row.** Six columns, two of them numbers — `8787` and `1.9s` read as the same kind of thing until something says which is which. It is dim throughout, §3.4's tier for a section label, and its own labels are part of each column's width so the header and the rows cannot drift apart.
- **The `autostart` column says `on` or `off`** — whether the next run starts that worker. Words rather than a check and a cross: those need color to read quickly and §3.4 licenses no tier for them.
- **The kind column says `app` or `worker`.** `app` is one of yours, from `apps/`; `worker` is a capability's own host Worker, resolved from the composition. The code and this page call the second a *host*, which is accurate and reads as a hostname in a six-character column — so the table says `worker`, and `pithy dev --list` says the same thing through the same helper.
- **A ready worker reports how long it took, not how long it has been up.** `1.9s` is the `Done. (3.2s)` fact, and it stops changing once it is true. A worker still coming up reports elapsed, which is the number that is actually moving.
- **And the roster stops repainting once the session is quiet.** The clock ticks only while something is still building. A command you leave open for eight hours does not redraw itself for eight hours.
- **`exited (1)` is a row, not a silence.** One worker exiting still tears the session down — that has not changed — but the roster names which one, and its last frame stays on screen afterwards so a session that stopped still says how.

**The keys.** `↑↓` moves the marker; the verbs act on the marked row. **A key that does nothing on that row is dimmed rather than hidden** — a bar whose contents move as the marker moves has to be re-read on every keystroke, and most of a real roster is capability hosts, which are neither a web page nor a sign-in.

| Key | Does | Dimmed on |
|---|---|---|
| `r` | **Restart that worker**, in place, on the same pinned port. This is the answer to the one failure nothing else fixes: a `wrangler dev` whose *first* build fails never rebuilds, so fixing the file and waiting cannot work. Before this, the only remedy was Ctrl-C and restarting everything. | — |
| `o` | Open its origin in your own browser. | a capability worker |
| `f` / `F` | **One slot, two keys.** `f` shows that worker's output, replaying the last 200 lines it produced while hidden; press it again to stop, and reveal as many workers as you like. `F` shows **every** running worker's output, or goes back to quiet — it never reveals one this branch parked, which has no output to show. On a row where `f` does not apply the slot reads `F all logs` alone, rather than dimming a merged hint and claiming neither key works. | — |
| `l` | **Sign in on that worker.** Never dimmed for want of a seed: it is gated on the *worker* being a ready app Worker, and the supervisor answers who. Gating it on a seed made `l` dead for the life of any session that started unseeded, because the identity count is read once before anything spawns — pressing it re-reads the record, opens the only identity, offers the picker, or names `pithy seed`. The marker is the answer to "which worker", which matters because an app stack can carry more than one front end: `l` on `web` signs you into `web`. A worker with no dev-login route is refused by name rather than redirected to a sibling. With more than one seeded identity it opens the picker, below. | a capability worker |
| `a` | **Turn this branch's autostart for the worker off, or back on** — whether the *next* `pithy dev` starts it. Writes the same `dev-ports.json` key as `--disable-autostart`, scoped by the same three things: this checkout, this branch, this machine, committed nowhere. The label names the state it is moving to. **It does not stop the worker**: turning it off leaves it running, and its row reads `ready` *and* `off`, because those two facts genuinely disagree until the session restarts. | — |
| `q` | Stop the session. The same path as Ctrl-C. | — |
| `?` | The key list, when the terminal is too narrow to show it. | — |

Without the roster — a piped run, `--json`, CI — `l` keeps the behavior it always had: the worker carrying a front end wins, and a tie prints the choices rather than guessing.

### Choosing who to sign in as

With more than one seeded identity, `l` replaces the roster with a picker rather than printing the list:

```
────────────────────────────────────────────────────────
  Sign in as  tide█   2 of 29
▸ jonas.villumsen@tidewater.test
  keziah.mbeki@tidewater.test
────────────────────────────────────────────────────────
  ↑↓ select   ⏎ sign in   esc clear
```

- **Type to filter.** Any printable character narrows the list, matching anywhere in the email *or* the userId, case-insensitively — because what you reach for on a seed spread across five domains is the domain, which is never the prefix. Backspace takes a character back. A query matching nobody says `no match of 29` rather than showing an empty box.
- **`↑↓` moves, `⏎` signs in, `esc` clears the query and then closes.** Narrowing 29 to 2 and wanting the 29 back is one keystroke, not a reopen.
- **No digit keys, and the rows are not numbered.** They were, briefly: numbered by their place in the whole list, with a `1–9 jump` hint. Two things were wrong with it. While the window showed rows 8–17 that hint pointed at rows which were not on screen; and an email contains digits, so once typing filters, `1` cannot also mean "jump to row 1". Filtering reaches every identity, so the numbers had no remaining purpose — `dev.json` takes an email or a userId, never an index.
- **Ten rows at a time.** The window follows the marker and clamps at both ends, and the marked row is always visible.
- **It replaces the roster rather than sitting under it.** The roster answers *what is running*; this answers *who*, and only one of those is being asked. The roster comes back the moment you choose or cancel.
- **The roster's own keys are inert while it is open** — `r`, `o`, `f`, `a` and `q` all do nothing, since there is no row on screen to read them against, and `q` especially would tear the session down in answer to a question about signing in. Ctrl-C still stops the session.
- **Emails only, never a claim.** The same omission the ready banner makes, for the same reason.
- A seeded session of one identity never asks: `l` opens it. None at all says so, and names `pithy seed`.

Without a roster — piped, `--json`, CI — `l` keeps the behavior it always had: up to nine identities on the digit keys, and a prompt past that.

**`a` is the roster's answer to the same question `--disable-autostart` answers.** `pithy dev --app payments --disable-autostart` still works and still writes the same key; `a` is that, on the row, without stopping to type a worker's name. Either way the answer lives beside the port block — this checkout, this branch, this machine — and `pithy dev --list` reports it as `skipped  off here`.

**Ctrl-C still stops the session**, and still stops it the same way: SIGTERM to every child's process group, a grace window, then SIGKILL, then the state file is removed. The roster is unmounted after that, never instead of it.

**Press it again and it stops waiting.** A teardown is bounded — a child that survives SIGKILL is named, with its pid, and the session exits rather than waiting on it — so this is a backstop rather than the usual path. It exists because the roster holds the terminal: `shutdown` returns early once it has begun, so without a second press there would be no key that does anything while a teardown is in flight, and a child that would not die could not be stopped at all. The footer is unmounted first, which is what hands the terminal back.

**Where you get the plain stream instead.** The roster is for a person at a terminal; everything else reads the output.

| Condition | Why |
|---|---|
| `--json` | Every command is agent-drivable, and a machine reads one object per line. |
| stdout is not a terminal | A pipe or a redirect gets text, with no cursor movement in it. |
| `CI` is set | A build log is the thing plain output exists for. |
| `TERM=dumb` | The terminal has said it cannot do this. |
| `--no-tui` | Asked for, for one run. |
| `PITHY_NO_TUI` set to any non-blank value | The same, as a standing preference — a shell profile, for a terminal that renders the footer badly. A typed `--tui` overrides it. |

A terminal whose **stdin** is redirected (`pithy dev < /dev/null`) still gets the roster, with no key bar — and the dev-login line prints the URL instead of offering `l`, exactly as it does on the plain path.

### Signing in: press `l`

`pithy seed` mints a dev login for **every user it seeds** (`docs/commands/seed.md`). `pithy dev` is where you use them.

- **The ready banner names the user, or how many there are.** With one seeded identity: `Dev login: ada@example.com — press l to open a signed-in browser.` With several: `Dev login: 4 identities — press l to choose who to be and open a signed-in browser.` It cannot name *the* user when there is a choice to make, and picking one to name would be making the choice. **No claim and no session cookie is ever printed** on a run where `pithy dev` can open the browser itself, to the terminal or to `logs/dev.log`. It used to be — a `document.cookie = "…"` line to paste into a browser console — and a working session token rendered as text is a working session token at rest in a scrollback, a log, and a screenshot. The value now travels from the Worker to the browser over HTTP and lands nowhere else.
- **`l` asks who, then does what it always did.** One identity opens straight away. Two to nine are numbered and one keypress picks: `Which identity? Press 1–4.`, then `1`. Ten or more get a filterable prompt instead, because there is no tenth digit to bind. The choice is over *users*; which worker to open is the separate question below, decided the same way it always was however many identities exist.
- **An expired claim takes one name out of the list.** Each entry carries its own expiry, so a stale one is absent from the picker and the rest stay usable. When every one has expired, `l` says so and names `pithy seed`, exactly as it did when there was one.
- **Every seeded user, not a fixed cast.** The source is the auth rows this run seeds, so an adopter's own seed set yields an adopter's own users; the canonical cast is only what `seed.includeExamples` adds to them. The opt-in is still per machine and is the **`user` key** in `~/.config/pithy/<project>/dev.json` — that file has other tenants, so its existence alone mints nothing — and the user it names is the one offered first (`docs/SEED.md`).
- **The seed is read when you press `l`, not when the session started.** So `pithy seed` in another terminal is picked up by the next keypress, and an identity that expires during a long session stops being offered. This used to be read once at startup, which made the refusal's own advice — `Run pithy seed, then press l again` — the one remedy that could not work: the session held the record as it stood before the seed, and pressing `l` again could never see it.
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
<project>-f<issue>-<slug>--<worker>          acme-f69-media-cli--api      (Worker script)
<project>-f<issue>-<slug>--<binding>-<kind>  acme-f69-media-cli--db-d1    (D1)
```

`pithy provision --feature` writes into each Worker's config, under `env.<env>`:

- **`name`** — the script name that Worker deploys under for the feature, so a preview deploy never overwrites production's.
- **`services[]`** — every `service` binding retargeted at the *feature's* copy of the callee. A capability declares the target Worker on the binding (`{ type: "service", name: "API", service: "api" }`); the CLI resolves `api` to `acme-f69-media-cli--api`. Worker-to-worker RPC therefore stays inside the feature environment instead of reaching production.

**Nothing is stored or committed to make this work.** Every name is derived from the branch, and an already-provisioned resource's id is recovered by looking that name up in Cloudflare — which is exactly what makes `provision` idempotent. On a second push, CI computes the same names, finds the existing D1/KV/R2, rewrites the same wiring, and deploys. There is no id file to merge, so there is nothing to conflict.

A feature environment *is* an environment, so `f<issue>-<slug>` simply occupies the environment slot of the one project-scoped rule every other name follows (`docs/NAMING.md`). **Two hyphens end the slug**, and nothing else Pithy composes holds two in a row, so a feature name can never be a declared environment's, a sibling branch's, or another project's (#643). A project whose name carries an `f` and a number as one segment, such as `acme-f12-x`, can have no feature environments; `docs/NAMING.md` says why.

**This is the tightest shape Pithy composes, and it is the shape that caps the project name.** Held to R2's 63 characters, with 8 taken by the fixed literals — `-f`, four more hyphens (two of them together, after the slug), and the two-character kind — the four variable segments divide 55 between them: `project + issue + slug + binding = 55`. The issue number is reserved 6 digits, so a 12-character project with a `DB` binding leaves 35 characters of slug at a 6-digit issue, and 39 at a real 2-digit one. A slug over budget is refused, never truncated: `pithy feature create` and `pithy provision --feature` name the longest slug the project takes at that issue (#643). A truncated slug was a short hash, and one branch's hash can be another branch's whole slug. Keep the part of the branch name after the issue number to roughly 20 characters. `docs/NAMING.md` has the budget worked out per project length.

`<project>` is `pithy.config.ts`'s `name` — required for `pithy feature` naming, with no guessed fallback. `resolveProjectName`'s lenient guesses (an app Worker's `wrangler.jsonc` name, the project directory's basename) are not stable across machines and checkouts, and teardown has no record of a resource beyond its computed name: a wrong guess means `pithy feature destroy` computes names that match nothing, deletes nothing, and exits 0. Set `name` in `pithy.config.ts`; a project without one gets an actionable error the first time a feature command needs it.

### Voice

All `pithy dev` output obeys the brand voice (`docs/CLI.md` §3 / `BRAND.md` §5): labeled lines, deliberate periods, no celebration. The ready banner is information, not confetti.

## `--json`

**Every line on stdout is one object.** A session keeps running, so a script reads `pithy dev --json` line by line rather than waiting for it to end. `pithy dev --list --json` is the other shape: it writes one line and exits.

Everything said to a person moves to stderr under `--json` — the `Starting …` line, the delivery verdict, a `.dev.vars` refusal, and the workers' own output, which is the bulk of the stream and every line wrangler and Vite print. It used to share stdout with the JSON, so `pithy dev --json | jq` choked on the first thing wrangler said and a consumer's only rule was to try each line and skip whatever failed to parse — which skips a JSON line we get wrong just as quietly. Splitting by descriptor costs a person nothing: both halves still reach the terminal, and `logs/dev.log` carries the lot in either mode. A run that stops on an error writes the `{"error": …}` line to stderr, as every `pithy` command does.

### The session line

Written as soon as every worker is started. It is what tells a script where the workers are.

```json
{"command":"dev","workers":{"api":{"port":8787,"origin":"http://localhost:8787"},"web":{"port":8788,"origin":"http://localhost:8788"}},"identities":[{"userId":"example-ada","email":"ada@example.com","expiresAt":"2027-07-27T00:00:00.000Z"}]}
```

| key | type | meaning |
|---|---|---|
| `command` | string | `"dev"`. |
| `workers` | object | One entry per started worker, keyed by its name. |
| `workers.<name>.port` | number | The port that worker was assigned in `.dev.config.json`, verified free before it started. |
| `workers.<name>.origin` | string | The localhost address its siblings were told to call it on. |
| `identities` | array | One entry per seeded user this session can sign in as. Empty when nothing is seeded, and empty when every claim has expired. |
| `identities[].userId` | string | The seeded user's id — canonical, and what the login artifact is keyed by. |
| `identities[].email` | string | The seeded user's address — what a person recognizes. |
| `identities[].expiresAt` | string | ISO-8601. When that identity's claim stops being accepted. |

**`identities` names who, and never how.** There is no `claim` key on the line and there is not going to be one: a claim mints a session for whoever presents it, and a machine-readable line is as public as a printed one — tee'd, piped, logged and pasted like every other. The line says which identities exist so a script can pick one; signing in is the browser's half, through `l` or through `/__pithy/dev-login`.

The field arrived with `#667`, which is also when the artifact gained an entry per seeded user. Before it the line carried four keys and a script had nothing to select against.

### The still-waiting line

Written 90 seconds after the last worker is spawned, and every 30 seconds after that, while any worker has started and not become ready (What it does, above). Not written while every worker is ready — and written again, on the same schedule, once a restart leaves one of them not ready.

```json
{"command":"dev","event":"still-waiting","waiting":["support"]}
```

| key | type | meaning |
|---|---|---|
| `event` | string | `"still-waiting"`. What distinguishes this line from the session line above. |
| `waiting` | array of string | The workers that have started and not matched their `dev.readySignal` yet, in start order. Read afresh at every report, so a worker that arrives late is gone from the next one. |

**Why the session line cannot carry this.** It is written the moment the children are spawned, and readiness is decided after it — a run whose `support` worker cannot build emits exactly the same session line as a healthy one. Without this second line, an agent driving `pithy dev --json` sits in the position `#426`'s adopter was in: a session that never says it is ready and nothing on the wire naming what is missing. The prose report is not on stdout under `--json` — it goes to stderr and to `logs/dev.log`, both read by a person in either mode.

### The list line

Written by `pithy dev --list`, which writes this line and nothing else, then exits.

```json
{"command":"dev","event":"list","members":[{"name":"api","kind":"app","autostart":true,"autostartLocal":false,"starts":true,"port":8787,"origin":"http://localhost:8787"}]}
{"command":"dev","event":"autostart","branch":"main","apps":["payments"],"enabled":false,"autostart":{"payments":false}}
```

| key | type | meaning |
|---|---|---|
| `event` | string | `"list"`. What distinguishes this line from the two above. |
| `members` | array of object | Every member of the dev set, `apps/` Workers in discovery order followed by the capability hosts. Always the whole set, whatever `--app` names. |
| `members[].name` | string | The member's name — its deployed name, or a host's capability name. What `--app` accepts, and what `<STEM>_ORIGIN` is derived from. |
| `members[].kind` | string | `"app"` for a Worker in `apps/`, `"host"` for a composed capability's host Worker. |
| `members[].autostart` | boolean | Whether a plain `pithy dev` starts it. `true` unless this branch has turned it off. |
| `members[].autostartLocal` | boolean | Whether `autostart` came from this branch's `dev-ports.json` answer rather than being the default. |

One more object, written by `--disable-autostart` and `--enable-autostart` instead of a run:

| Key | Type | Meaning |
| --- | --- | --- |
| `event` | string | `autostart`. |
| `branch` | string | The branch the answer was written under — the `dev-ports.json` key. |
| `apps` | string[] | The workers it was written for, as `--app` resolved them. Named `apps` and not `workers` because `workers` already means the run's name → `{port, origin}` map on this page, and one key meaning two things on one page is a key nobody can parse. |
| `enabled` | boolean | `false` for `--disable-autostart`, `true` for `--enable-autostart`. |
| `autostart` | object | This branch's whole answer after the write: worker name → whether it starts. |
| `members[].starts` | boolean | Whether *this* invocation would start it: the autostart set, or exactly what `--app` named. |
| `members[].port` | number or null | The port it would be pinned to, or `null` when the project has no `.dev.config.json` yet. |
| `members[].origin` | string or null | The address its siblings would reach it at, or `null` when no port is pinned. |

Notes — a project that states no name, a Worker whose capabilities could not be read, a project with no ports pinned yet — go to stderr, as everything said to a person does under `--json`. Only the line above is on stdout.

## Errors

`pithy dev` supervises, so most of what can go wrong is reported and survived rather than thrown.

- **A pinned port is taken.** The run reports the conflict and stops. It never drifts to another port: a worker that quietly moves breaks every sibling that was told its address at creation.
- **A `.dev.vars` pithy did not write.** Never overwritten and never merged. The file is named, `.dev.vars.local` is offered as the place for local values, and that worker starts without one.
- **A worker whose `.dev.vars` could not be written.** Named, and every other worker still starts.
- **A worker exits.** The rest come down with it. `SIGINT` or `SIGTERM` tears the whole session down the same way — graceful `SIGTERM`, then `SIGKILL` after a short grace window.
- **`l` with no browser to open.** A machine with no `xdg-open` gets one line naming the URL to open by hand. The session keeps running: no browser is not a reason to stop supervising workers.
- **An unknown `--app` name.** The whole run is refused before anything spawns, and the valid set is named. Nothing half-starts.
- **An `apps/` Worker named after a capability host.** Refused, for a run and for `--list` alike: siblings reach a host at `<CAPABILITY>_ORIGIN`, and two workers sharing one name would publish one address for two processes.
- **Two workers deployed under one name.** `--app <that name>` is refused, naming the two directories that tell them apart. The project is already broken in the same way: `.dev.config.json` keys a port by the deployed name, so both workers share one entry.
- **An `--app` with no name after it.** Refused. An empty selection means *start everything*, so a forgotten name would spawn the whole estate — the opposite of what was typed.
- **More members than the feature's port block holds.** Refused with the count, and the fix — remove a worker or a capability, or widen the block. A capability's host counts toward it, so removing a capability is as much a fix as removing a Worker. `--list` refuses this too, because it is the same arithmetic the next run does.

## Examples

```bash
# Start the whole set — every worker under apps/ that has not opted out, plus each composed capability's host.
pithy dev

# The same, reporting each worker's resolved port and origin as one line of JSON.
pithy dev --json

# Print the set a run would start — kind and pinned port per member — and start nothing.
pithy dev --list

# Start one worker. Nothing else comes with it.
pithy dev --app board

# What would that actually give me?
pithy dev --list --app board
```
