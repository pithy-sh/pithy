# Pithy CLI Specification

> The CLI is the brand's primary interface. Every command, every flag, every output line should feel like Pithy — short, deliberate, and confident. This document specifies what every command shares: the command shape, the flag conventions, the alias, the output styling, the help text, and the update notifier. What one command does is specified on its own page under [`docs/commands/`](commands/) — §1.4 indexes them. For visual identity, voice, and color tokens, see `BRAND.md`.

---

## 1. Command structure

Pithy uses a verb-noun command pattern:

```
pithy <command> [subcommand] [args] [--flags]
```

Examples:

```
pithy init
pithy add auth
pithy add leaderboard
pithy remove leaderboard
pithy dev
pithy deploy
pithy upgrade
pithy alias
pithy doctor
```

The binary is always `pithy`. The alias system (Section 3) ships a shorter shortcut, but the canonical command name never changes.

### 1.1 Standard commands

| Command | Purpose |
|---|---|
| `pithy init` | Scaffold a new Pithy project in the current directory |
| `pithy add <capability> [--worker <name>]` | Install a capability (auth, leaderboard, storage, vector) — installs the package, wires it into **that Worker's** `apps/<name>/pithy.config.ts` and `wrangler.jsonc`, writes any Durable Object class it binds into that Worker's entry (wrangler resolves `class_name` against the module `main` names), scaffolds its **config** (you pick the mount path; handler source stays in the package), and runs its migrations. `--eject` copies the source into your repo — the only path that writes handler source (see `docs/EJECT.md`) |
| `pithy remove <capability> [--worker <name>]` | The manual, interactive inverse of `add` (and `add --eject`): unwires that Worker's config, bindings, and Durable Object exports, and uninstalls the package (or deletes the ejected source), leaving your data untouched unless you pass `--drop`. **Manual-only — `--json` is rejected** (see below) |
| `pithy worker <add\|list\|remove\|rename\|sync> [name]` | Manage the project's Workers under `apps/<name>/`; `apps/` is the registry every command discovers (see [`commands/dev.md`](commands/dev.md)). `rename` moves the directory and the two other places a Worker's name is stamped (see Section 6.6). `sync` writes the Worker's **app-declared** Workflows and cron triggers into its `wrangler.jsonc`, for every environment it declares — the app's equivalent of what `pithy <capability> provision` writes for a library capability's (see Section 6.5) |
| `pithy ui <add\|sync\|list> [--worker <name>]` | Scaffold a front end into an existing Worker and wire it end to end — Vite, the SPA entry, the routes, the `assets` stanza, the dev command. `sync` re-derives the asset routing after the Worker's capabilities change; `list` reports which Workers carry a UI (see [`commands/ui.md`](commands/ui.md) and `docs/UI.md`) |
| `pithy dev` | Start the local development environment — app Workers plus each composed capability's host Worker, on per-feature ports (see [`commands/dev.md`](commands/dev.md)) |
| `pithy migrate [--worker <name>]` | Run each Worker's migration registry against an `--env` (`--rollback` to downgrade). Fans out over every Worker; Workers sharing a database migrate it once |
| `pithy seed [--worker <name>]` | Load seed/test data (same Zod schemas/codecs) for local dev or ephemeral CI — see [`commands/seed.md`](commands/seed.md) and `docs/SEED.md` |
| `pithy provision <--env <name> \| --feature>` | Create an environment's own Cloudflare resources — one per binding name across every Worker — write their ids into each Worker's config, and migrate. **One job, two spellings, exactly one of them required:** `--env` for an environment the project declares, `--feature` for the one this branch gets. Idempotent and adopting: a resource of the right name is taken up rather than duplicated. Every run states the file it wrote and whether that file is committed — `--env`'s ids are source in the tracked `wrangler.jsonc`, `--feature`'s are a build artifact under the already-ignored `.wrangler/`. `deploy` refuses and names this command when a binding has no id; production takes a type-to-confirm phrase that `--yes` never replaces (see [`commands/provision.md`](commands/provision.md)) |
| `pithy feature` | Feature environment lifecycle: `create` (local worktree, ports, migrate + seed), `sync` (make an existing worktree ready), `destroy` (tear it all down). All three derive the feature from the checked-out branch. Its live Cloudflare environment is `pithy provision --feature`'s |
| `pithy env [--worker <name>]` | Report each Worker's deployment environments (`dev`/`staging`/`prod`), their bindings, resolved ids, and dashboard links — read-only, switches nothing |
| `pithy dashboard <connect\|rotate\|revoke-key\|disconnect\|status>` | Register, rotate, revoke, and inspect a management client's access to this project — project-wide and **per environment**, never per Worker. `connect` resolves the Worker's address and the seam's base path from the project (it prints both and where they came from; `--worker-url` overrides, and `--worker <name>` is required when a project has several Workers), runs a browser device-code flow, writes the trusted public key into your own D1, and reports connected only once a signed ping round-trips; `--public-key` registers a key you generated yourself, with no dashboard involved. `revoke-key` pulls one leaked key and leaves the connection standing; `disconnect` removes the lot. Both are local, immediate, and need nothing from the client. See `docs/CONTROL-PLANE.md` |
| `pithy deploy` | Deploy to Cloudflare Workers. A Worker carrying a UI builds it first — its manifest's `ui.build`, then `wrangler deploy` (see [`commands/ui.md`](commands/ui.md)) |
| `pithy upgrade [--worker <name>]` | Reconcile package-served capabilities with current manifests, per Worker — **skips ejected capabilities** (a forked, local-import capability is never reconciled) |
| `pithy alias` | Install or remove the shell shortcut (see Section 3) |
| `pithy doctor [--worker <name>]` | Report toolchain state and update status, plus — inside a project — each Worker's config, binding, and migration health (exits non-zero when any Worker fails a check, so CI can gate on it) |
| `pithy --help` / `pithy -h` | Show help for any command |
| `pithy --version` / `pithy -v` | Print the installed version |

**Every Worker lives in `apps/<name>/`, and owns its own config.** There is no root Worker. A Worker's
`apps/<name>/pithy.config.ts` declares `{ capabilities, app }` — what *that* Worker is made of — because
everything capabilities drive is per-Worker: the composed route tree, the `requiredBindings` written into
that Worker's `wrangler.jsonc`, and Durable Object class migrations, which register a class against a
specific script. The **root** `pithy.config.ts` carries only what cannot be per-Worker: `name` (the leading
segment of **every** name this project provisions — D1, KV, R2, Vectorize, Worker scripts, Workflows, Secrets
Store entries, API tokens; see `docs/NAMING.md`), `tokens`, and `seed.productionEnvironments`. `name` stops
at 26 characters and is effectively permanent; `docs/NAMING.md` derives the number and lists every namespace's
real limit.

**One project, or two?** Do these apps share users or data? Then it is one project with more Workers, not two projects. Two apps often should share. Two projects never can — each carries its own migration registry and upgrade cadence, so one project's `pithy migrate` applies schema the other has never heard of, and `pithy migrate` refuses a database another project owns. `pithy worker add` is the answer far more often than a second `pithy init`. Full reasoning in `docs/NAMING.md`.

Two consequences worth stating outright:

- **Commands that wire one Worker take `--worker <name>`** (`add`, `remove`). With a single-Worker project
  the flag is optional; with several, the CLI prompts at a terminal and **fails with an actionable error
  under `--json`** rather than guessing — wiring a capability into the wrong Worker would put its bindings
  and DO class migrations on the wrong script. Commands that operate on the whole project (`migrate`, `seed`,
  `upgrade`, `doctor`, `env`) **fan out over every Worker** and accept `--worker` to narrow.
- **Workers share a resource by declaring the same binding name.** Feature resource names derive from
  `(project, issue, slug, binding, kind)` with no Worker segment, so two Workers that both declare `DB` are
  backed by one D1; a Worker wanting its own declares a different binding (e.g. `COLLAB_DB`). Locally this is
  why Miniflare state persists at the project root — per-Worker state would silently split a shared database.

### 1.2 Flag conventions

- Long flags: `--flag-name` (kebab-case)
- Short flags: `-f` (single letter)
- Boolean flags default to `false`; pass to enable
- Values pass with `=` or space: `--env=prod` or `--env prod`
- `--help` / `-h` and `--version` / `-v` work on any command. citty answers its version builtin only when it is the *sole* argument, so `bin.ts` answers it first and `pithy add --version` prints the version instead of running `add`. It fires on a bare `--version` or `-v` anywhere before a `--` separator; a value that is literally the string passes as `--flag=--version` or after `--`

**`--env` takes `dev`, `staging`, or `prod`, and it is validated at the flag.** It defaults to `dev`, because every command is safe there. It is **not** `production`: the environment sits verbatim in the middle of every Cloudflare name the project composes, so each of its characters costs one character of project name, one for one — and `--env production` is answered with an error naming `prod`. A custom environment is allowed (`live`, `eu-prod`), held to the same charset and to a hard maximum of 7 characters, the length of `staging`. Every project-name budget is derived against that 7, and a provisioned project cannot be renamed, so a longer environment is refused rather than quietly shrinking a cap projects were already accepted under.

**Which of them this project has is declared**, once, as `environments` in the root `pithy.config.ts` — `["staging", "prod"]` unless it says otherwise, asked at `pithy init` with that default. A command that deploys or provisions refuses an `--env` the project does not declare, naming the ones it does; `dev` is never declared, because it is local and always there. See `docs/NAMING.md`.

Every command is agent-drivable and supports `--json`, with **one deliberate exception**: `pithy remove` is destructive, so it is **manual, interactive-only** — passing `--json` fast-fails with a clear error before anything changes. Its `--drop` confirmations are typed at a real terminal; there is no headless path. Automated teardown of an ephemeral environment is a different command (the `feature` lifecycle), not `remove`.

### 1.3 The gates a scaffold ships with

`pithy init` writes the three checks CI needs, not only the two commands a developer runs:

| Script | Runs | Config |
|---|---|---|
| `bun run typecheck` | `tsc -b` | `tsconfig.json` — the solution file |
| `bun run test` | `vitest run` | `vitest.config.ts`, `vitest.workers.config.ts` |
| `bun run lint` | `biome check .` | `biome.jsonc` |

**The root `tsconfig.json` is a solution file, and it has to be.** It declares `"files": []` and a list of `references`, and `tsc -b` builds each in turn. The programs cannot be merged into one: a Worker needs `@cloudflare/workers-types`, a browser client needs the DOM, and a program carrying both makes `Uint8Array` structurally incompatible with `BufferSource` — which breaks every crypto call in Pithy's own control-plane signing code. Keeping the two type worlds apart is not tidiness; it is the only arrangement that compiles. A fresh project references two programs — `tsconfig.tools.json`, for the configs that run on Node, and `apps/<worker>/tsconfig.json` — and `pithy ui add` appends the client's two.

**`references` requires `composite: true`, and `composite` makes tsc write a `.tsbuildinfo`.** Each program names its own, under the **project's** `dist/`: already covered by the scaffolded `.gitignore`, so no `*.tsbuildinfo` rule is needed, and deliberately not a Worker's `dist/`, which Vite owns and empties on every client build. One file per program, named after its Worker — two composite programs pointing at one build-state file overwrite each other's, and the incremental build goes quietly wrong.

**The Vitest config comes split by runtime.** `*.workers.test.ts` runs inside workerd against a real D1 database and a real KV namespace through Miniflare; every other `*.test.ts` runs in Node. That split is the kit's whole testing argument — a test that mocks D1 proves the mock works — and the Workers half is the fiddly one to wire, which is why it is scaffolded rather than described. Its bindings are declared in `vitest.workers.config.ts`, with a matching `Cloudflare.Env` in `apps/<worker>/src/cloudflare-test.d.ts`; a capability that needs a new one needs it in both.

**Biome formats everything, including the two files Pithy rewrites.** `wrangler.jsonc` and `pithy.worker.jsonc` are edited in place by `pithy add`, `pithy provision` (both modes — `--feature`'s write lands in the generated copy under `.wrangler/`), `pithy ui add`, and `pithy ui sync` — through one comment-preserving printer that emits what Biome would, so a command's output needs no formatting step and passes the pre-commit hook the CLI itself installs. They were exempted from the scaffolded formatter once, which was the same defect in another form: it left the two files Pithy touches most as the two files nothing formats.

One gap, stated rather than hidden: `pithy worker add` writes the new Worker's `tsconfig.json` with the same settings `init` gives `apps/api`, but does **not** add it to the solution file. Add the reference yourself, or that Worker's source is typechecked by nothing.

### 1.4 The command pages

One page per command, under [`docs/commands/`](commands/). Every page carries the same six sections — synopsis, flags, what it does, `--json`, errors, examples — so a command's contract is specified where the command is, and specified completely: a gate in `packages/cli/src/commands/doctorDocs.test.ts` holds each page to naming every key its command's `--json` payload emits.

| Command | Page |
|---|---|
| `pithy add` | [`commands/add.md`](commands/add.md) — Install a capability into a Worker |
| `pithy alias` | [`commands/alias.md`](commands/alias.md) — Install or remove the `p.` shortcut |
| `pithy dashboard` | [`commands/dashboard.md`](commands/dashboard.md) — Register and revoke a management client's access |
| `pithy deploy` | [`commands/deploy.md`](commands/deploy.md) — Deploy to Cloudflare Workers |
| `pithy dev` | [`commands/dev.md`](commands/dev.md) — Run every Worker the project composes locally under one supervisor |
| `pithy doctor` | [`commands/doctor.md`](commands/doctor.md) — Check the toolchain, the project, and for a new CLI version |
| `pithy email` | [`commands/email.md`](commands/email.md) — Send, template, and inspect transactional mail |
| `pithy env` | [`commands/env.md`](commands/env.md) — Report every Worker's environments, bindings, and ids |
| `pithy feature` | [`commands/feature.md`](commands/feature.md) — Feature environment lifecycle |
| `pithy init` | [`commands/init.md`](commands/init.md) — Scaffold a new Pithy project |
| `pithy media` | [`commands/media.md`](commands/media.md) — Provision and manage the media backends |
| `pithy migrate` | [`commands/migrate.md`](commands/migrate.md) — Run each Worker's migration registry |
| `pithy payments` | [`commands/payments.md`](commands/payments.md) — Provision and inspect the payments capability |
| `pithy remove` | [`commands/remove.md`](commands/remove.md) — Unwire a capability. Manual only |
| `pithy secrets` | [`commands/secrets.md`](commands/secrets.md) — Create, rotate, edit, and provision the secret registry |
| `pithy seed` | [`commands/seed.md`](commands/seed.md) — Seed an environment from your Zod-typed fixtures |
| `pithy storage` | [`commands/storage.md`](commands/storage.md) — Provision and manage the storage backends |
| `pithy support` | [`commands/support.md`](commands/support.md) — Provision and manage the support capability |
| `pithy testers` | [`commands/testers.md`](commands/testers.md) — Cohorts, invitations, and tester rosters |
| `pithy token` | [`commands/token.md`](commands/token.md) — Mint, list, and revoke API tokens |
| `pithy turnstile` | [`commands/turnstile.md`](commands/turnstile.md) — Provision the humanity check |
| `pithy ui` | [`commands/ui.md`](commands/ui.md) — Scaffold a front end into a Worker and wire it |
| `pithy upgrade` | [`commands/upgrade.md`](commands/upgrade.md) — Reconcile package-served capabilities with their manifests |
| `pithy vector` | [`commands/vector.md`](commands/vector.md) — Provision and manage Vectorize indexes |
| `pithy worker` | [`commands/worker.md`](commands/worker.md) — Manage the project's Workers under `apps/` |

---

## 2. The alias system

The brand is built on concision. The CLI ships with an opt-in shortcut that's even more pithy than `pithy`.

### 2.1 The shortcut

```
p.   →   pithy
```

Two characters. Ends in the brand mark. Encodes the logo into shell muscle memory.

After installation, the user can substitute `p.` anywhere `pithy` would appear:

```bash
p. init
p. add auth
p. deploy
p. --help     # works identically to pithy --help
```

### 2.2 How users discover and install the alias

Three surfaces, each appropriate to a different moment.

**Surface 1: During `pithy init`**

After scaffolding completes, the installer asks once:

```
Done.

Want a shortcut? Type `p.` instead of `pithy`. [Y/n]
```

- Default response: `Y`
- If yes: writes alias to shell rc file, prints confirmation
- If no: never asks again in this project; user can still install later via `pithy alias`

**Surface 2: The `pithy alias` subcommand**

For users who skipped install, are on a second machine, or want to remove the alias:

```
pithy alias              # install (idempotent)
pithy alias --remove     # uninstall
pithy alias --status     # report whether installed
```

This is the documented, supported surface. Listed in `pithy --help`.

**Surface 3: The `--pithier` easter egg**

```
pithy --pithier
```

Hidden flag. Does the same thing as `pithy alias`. Not in `--help`. Mentioned only in the docs (in a sidebar callout) and in the launch blog post. The discovery moment is part of the brand experience.

### 2.3 The anti-feature: `--pithiest`

If a user reaches for more, the CLI declines:

```
$ pithy --pithiest
Pithy enough.
$
```

Exits 0. No alias is installed. No error. The refusal *is* the joke — the brand is honest about its limits.

This flag is also not in `--help`. Like `--pithier`, it's discovered.

### 2.4 Shell detection and file paths

The installer detects the user's shell and writes the appropriate syntax to the appropriate file:

| Shell | Detection | RC file | Alias syntax |
|---|---|---|---|
| bash | `basename "$SHELL"` ends with `bash` | `~/.bashrc` (or `~/.bash_profile` on macOS) | `alias p.='pithy'` |
| zsh | ends with `zsh` | `~/.zshrc` | `alias p.='pithy'` |
| fish | ends with `fish` | `~/.config/fish/config.fish` | `alias p. pithy` |
| PowerShell | platform = Windows + `$PSVersionTable` | `$PROFILE` (typically `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`) | `function p. { pithy @args }` (Set-Alias rejects `.` in names) |
| nushell | `basename "$SHELL"` ends with `nu` | `~/.config/nushell/config.nu` | `alias p. = pithy` |

**Unknown or unsupported shells:** Print the alias line and instruct the user to add it manually. Never silently fail; never write to an unrecognized rc file.

**macOS bash users:** macOS ships with bash 3.2 by default and the `.bash_profile` convention. Detect macOS via `uname` and prefer `.bash_profile` over `.bashrc`; fall back to `.bashrc` if `.bash_profile` doesn't exist.

### 2.5 Idempotency and safe edits

The installer must never duplicate the alias or corrupt existing config:

1. **Read before write.** Check whether `alias p.=` (or shell equivalent) already exists in the file.
2. **Wrap with markers.** Wrap the added line with a marker comment so `--remove` can find and delete exactly the block we added:
   ```bash
   # >>> pithy alias >>>
   alias p.='pithy'
   # <<< pithy alias <<<
   ```
3. **Append, never rewrite.** Open in append mode; never read-modify-write the entire file.
4. **Create the file if it doesn't exist.** Touch the rc file with appropriate permissions (e.g., `0644` on POSIX) if the user has no shell config yet.
5. **Permission check.** If the file is read-only or not writable, fail with a clear error pointing the user to manual install.
6. **No symlink traversal.** Refuse to write if the rc path is a symlink to outside the user's home directory.

### 2.6 Removal

```
pithy alias --remove
```

Locates the marker block from Section 2.5, removes those lines, leaves everything else untouched. If no marker is found, reports "No Pithy alias installed." and exits 0.

### 2.7 User interaction flow

**First-time install during init:**

```
$ pithy init

▸ Creating project structure...
▸ Initializing wrangler.jsonc...
▸ Installing @pithy-sh/core...

Done.

Want a shortcut? Type `p.` instead of `pithy`. [Y/n] y

Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc

$ source ~/.zshrc
$ p. --version
pithy 1.0.0
```

**Standalone install:**

```
$ pithy alias
Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**Already installed:**

```
$ pithy alias
Already pithy.
$
```

**Status check:**

```
$ pithy alias --status
Installed in ~/.zshrc
$
```

**Removal:**

```
$ pithy alias --remove
Removed `alias p.='pithy'` from ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**The hidden easter egg:**

```
$ pithy --pithier
Added `alias p.='pithy'` to ~/.zshrc
Reload your shell or run: source ~/.zshrc
```

**The anti-feature:**

```
$ pithy --pithiest
Pithy enough.
```

### 2.8 Implementation outline

```ts
// src/commands/alias.ts

import { detectShell } from '../platform/shell';
import { readRcFile, appendToRcFile, removeFromRcFile } from '../platform/rc';

const MARKER_OPEN = '# >>> pithy alias >>>';
const MARKER_CLOSE = '# <<< pithy alias <<<';

export async function installAlias(opts: { silent?: boolean } = {}) {
  const shell = await detectShell();
  if (!shell) {
    return logManualInstructions();
  }

  const contents = await readRcFile(shell.rcPath);
  if (contents.includes(MARKER_OPEN) || /\balias\s+p\.\s*=/.test(contents)) {
    if (!opts.silent) console.log('Already pithy.');
    return;
  }

  const block = [
    MARKER_OPEN,
    shell.aliasSyntax,
    MARKER_CLOSE,
  ].join('\n');

  await appendToRcFile(shell.rcPath, '\n' + block + '\n');
  console.log(`Added \`${shell.aliasSyntax}\` to ${shell.rcPath}`);
  console.log(`Reload your shell or run: source ${shell.rcPath}`);
}

export async function removeAlias() {
  const shell = await detectShell();
  if (!shell) return logManualInstructions();

  const removed = await removeFromRcFile(shell.rcPath, MARKER_OPEN, MARKER_CLOSE);
  if (!removed) {
    console.log('No Pithy alias installed.');
    return;
  }
  console.log(`Removed \`${shell.aliasSyntax}\` from ${shell.rcPath}`);
  console.log(`Reload your shell or run: source ${shell.rcPath}`);
}

export async function aliasStatus() {
  const shell = await detectShell();
  if (!shell) return console.log('Unable to detect shell.');

  const contents = await readRcFile(shell.rcPath);
  if (contents.includes(MARKER_OPEN)) {
    console.log(`Installed in ${shell.rcPath}`);
  } else {
    console.log('Not installed. Run `pithy alias` to install.');
  }
}

// The easter egg + anti-feature live as global flag handlers
// in the main CLI dispatch (src/cli.ts), not in any subcommand:

export function handleHiddenFlags(argv: string[]): boolean {
  if (argv.includes('--pithier')) {
    installAlias();
    return true;
  }
  if (argv.includes('--pithiest')) {
    console.log('Pithy enough.');
    return true;
  }
  return false;
}
```

### 2.9 Testing checklist

- [ ] Idempotency: running `pithy alias` twice doesn't duplicate the block
- [ ] Removal: `pithy alias --remove` removes only the marker block, leaves other config intact
- [ ] Permissions: read-only rc file produces a clean error message, not a stack trace
- [ ] Missing rc file: installer creates it with safe permissions (`0644`)
- [ ] Unknown shell: installer prints manual instructions, exits 0
- [ ] macOS bash detection: prefers `.bash_profile` if present
- [ ] PowerShell on Windows: uses `function p.` (not `Set-Alias`)
- [ ] Fish syntax: uses `alias p. pithy` (no `=`)
- [ ] `--pithiest` never modifies any file
- [ ] `--pithier` is functionally identical to `pithy alias`

---

## 3. Output styling

Pithy CLI output follows the brand voice (see `BRAND.md` Section 5). Concise lines, deliberate periods, restrained color use.

### 3.1 Status lines

Operations in progress prefix with a status arrow:

```
▸ Installing @pithy-sh/auth...
▸ Updating wrangler.jsonc...
▸ Running migration: auth_0001_create_users...
```

- Arrow `▸` (U+25B8) in the default terminal foreground (don't try to force a color — terminals vary)
- Body text in default foreground
- Trailing `...` indicates in-progress; never used for completed messages

### 3.2 Completion

Successful operations end with a single line:

```
Done.
```

That's it. No emoji, no celebration, no "successfully completed in 2.3s." If timing is genuinely useful (e.g., long deploys), append it minimally:

```
Done. (3.2s)
```

### 3.3 Errors

Errors lead with what went wrong, then what to do:

```
Couldn't connect to Cloudflare API.
Check your CLOUDFLARE_API_TOKEN and try again.
```

- No stack traces in user-facing output (debug mode enables them via `--verbose`)
- First line: the problem, sentence-length, no jargon
- Second line: the action the user should take
- Color: ANSI basic-16 red (terminal-themed) for the first line; default otherwise. See Section 3.4.

### 3.4 Color tiers

The CLI runs in many terminals — light themes, dark themes, custom themes, transparent backgrounds, CI logs. The color layer respects this by using three tiers, picked deliberately per element:

| Tier | ANSI mechanism | Behavior |
|---|---|---|
| Terminal-themed attributes | `\033[2m` (dim), `\033[1m` (bold) | The user's terminal renders dim and bold correctly against any theme; no override of their colors |
| Terminal-themed basic-16 | `\033[31m`, `\033[33m`, etc. | The user's terminal defines what "red" looks like; works on light and dark themes equally |
| Truecolor (24-bit RGB) | `\033[38;2;R;G;Bm` | Exact color; used only when Pithy's brand color must remain constant |

Element-to-tier mapping:

| Element | Tier | Reason |
|---|---|---|
| Status arrow `▸`, primary text | None (default foreground) | Inherits terminal foreground; readable in any theme |
| Muted text (descriptions, paths, package names, section labels in command output) | Dim attribute | Reads as secondary against any background |
| Error text | Basic-16 red | User's terminal defines red; respects their theme |
| Warning text | Basic-16 yellow | Same reasoning |
| Help group headings, and `USAGE` / `COMMANDS` on the root screen (§4.3) | Basic-16 magenta + bold, and bold | The one help screen Pithy renders; bold marks the break, the user's terminal defines magenta |
| Saffron brand accent | Truecolor `\033[38;2;212;160;23m` (#D4A017); fall back to 256-color 178; fall back to no color | Brand mark; must be the same color everywhere it renders |

Where saffron appears (and only here):

- The `.` in `Done.` after successful operations
- Loading spinner glyphs during long operations
- Update notification "available" indicator
- Nowhere else — saffron earns its place by carrying meaning

Color is automatically **disabled** when:

- `NO_COLOR` env var is set to any value ([no-color.org](https://no-color.org/) standard)
- `process.stdout.isTTY` is false (piped output, CI logs without override)
- The terminal reports zero color support

Color is **forced on** when:

- `FORCE_COLOR` env var is set

**Implementation:** `picocolors` carries the terminal-themed tiers (zero-dep, ~1KB), but **not its detection** — picocolors reads any `CI` env as color-capable, and our output is parsed, so a CI runner or a piped consumer would find ANSI in `--json`. The seam decides for itself, once, from `NO_COLOR` / `FORCE_COLOR` / `isTTY`, and every colored character in the CLI flows through it — no raw ANSI anywhere else. Truecolor saffron is not exposed by `picocolors`, so it is written here directly.

The block below is `packages/cli/src/terminal/style.ts`, extracted verbatim and pinned by `packages/cli/src/terminal/styleDocs.test.ts`. Edit the seam and that test fails until this section is recaptured.

```ts
const SAFFRON_TRUECOLOR = "\x1b[38;2;212;160;23m"; // #D4A017
const SAFFRON_256 = "\x1b[38;5;178m";
const RESET = "\x1b[0m";

function supportsTruecolor(): boolean {
  const colorterm = process.env.COLORTERM;
  return colorterm === "truecolor" || colorterm === "24bit";
}

/**
 * Color is on only for an interactive terminal — never when the output is piped,
 * redirected, or captured. `NO_COLOR` forces it off, `FORCE_COLOR` forces it on
 * (the standard env overrides). We decide here rather than trusting
 * `pc.isColorSupported`: picocolors treats any `CI` env as color-capable, which
 * would bleed ANSI into our `--json` and `Done.` output the moment a CI runner
 * (or a piped consumer) reads it. Our output is parsed; a TTY is the real signal.
 */
function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

// Decided once at import, the way picocolors itself latches its detection.
const enabled = detectColor();

/**
 * The latched decision, for the one caller that needs the rule rather than a colored string: `bin.ts`
 * hands it to citty, which renders its own help and consults none of the above. Exported so the rule
 * lives in exactly one place — a second copy of it is how the help output came to disagree with every
 * other surface in the first place.
 */
export function colorEnabled(): boolean {
  return enabled;
}

/** The brand mark in terminal form. Truecolor → 256-color 178 → no color. */
export function saffron(text: string): string {
  if (!enabled) return text;
  return (supportsTruecolor() ? SAFFRON_TRUECOLOR : SAFFRON_256) + text + RESET;
}
```

**Help is citty's below the root, and citty decides color for itself.** The root screen is Pithy's and obeys the table above (§4.3). Every screen under it — `pithy add --help`, `pithy secrets`, the screen shown after an unknown name — is citty's `renderUsage`, from its own private flag, latched at import from `NO_COLOR === "1" || TERM === "dumb" || TEST || CI` — not `isTTY`, not `NO_COLOR` set to any other value, not `FORCE_COLOR`. Left alone, `pithy --help | cat` writes escape codes into a pipe while every other surface goes plain. So `bin.ts` reads `colorEnabled()` and, when it is false, sets `NO_COLOR=1` before citty is loaded. That translation runs one way only: Pithy never deletes `CI` to force citty's color back on, because that would rewrite the environment of every child process the CLI spawns. Plain help in a CI log is harmless; ANSI in a pipe is not.

### 3.5 Tables and lists

For multi-row output (e.g., `pithy add --list`), use clean aligned columns with two spaces between, no border characters. The root help screen is the one exception, and a deliberate one: it keeps citty's right-aligned name column and four-space gutter so that it and every subcommand screen — which are citty's and cannot be changed — read as one program (§4.3).

```
auth          Authentication and session management
storage       Object storage in your own R2, with quotas and share links
leaderboard   Ranking across daily, monthly, and all-time windows
vector        Semantic search with schema-declared metadata filters
```

No ASCII art boxes. No Unicode borders. The whitespace is the layout.

### 3.6 Prompts

Prompts follow the voice. Short question, default in brackets, period if it's a statement:

```
Use TypeScript? [Y/n]
Project name: [my-pithy-app]
```

Default values shown in brackets. `Y/n` means default yes; `y/N` means default no.

**A prompt that can be answered from the account, is.** `pithy init` and `pithy worker add` ask where a Worker will answer, per environment, and offer the account's real Cloudflare zones rather than a free-text field — so a typo fails at `init` with a list of what exists, instead of at `deploy` with a Cloudflare error to decode. Where the account cannot be reached — no credentials, a token without `Zone:Read`, an offline laptop — the prompt says so in one line and falls back to free text. Scaffolding has never required the network, and this does not change that.

**Every one of these is skippable.** A project without a domain yet is legitimate, and most are on the first day; an empty answer writes no `domains` block at all, and adding one later is a config edit plus a deploy, never a rescaffold. A non-interactive run asks nothing and declares nothing — `domains` goes in `pithy.config.ts` directly, which is exactly what the prompt writes.

**And the declaration is the only place an origin is written down.** Every capability that needs a public origin asks the same question: `auth.baseURL` builds OAuth callbacks, magic-link URLs and the CSRF allowed-origin; `email.baseUrl` builds tracking and unsubscribe links; `payments`' Stripe return URLs decide where Checkout sends the browser back. Write a URL into any of them and you have written *one* environment's origin into all of them — which is how a staging deploy mails real users links into production, an unsubscribe from a staging test unsubscribes that person in production, and a staging payer lands in production on an account that bought nothing. Three capabilities, one mistake, three separate discoveries.

So it is derived, and **`pithy init` scaffolds the derivation** — an adopter who never thinks about it gets it right, and one who wants a literal can still write one:

```ts
const DOMAINS = {
  // staging: { pattern: "staging.api.example.com", zone: "example.com" },
  // prod: { pattern: "api.example.com", zone: "example.com" },
};

export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);

const config = { domains: DOMAINS, capabilities: [ … ], app };
```

`originFor(environment, domains)` from `@pithy-sh/core/src/naming/domains` is the one answer to "where is this Worker reachable", and it is the same call `pithy` itself makes to generate `vars.BASE_URL` — so the Worker's runtime origin and the origins its capabilities were configured with cannot disagree. The declaration is **hoisted** because the origin has to exist before the capabilities that take it are constructed, and `domains: DOMAINS` beside them is the same object: one declaration, two readers. The prompt fills the const; it never writes a second `domains` key.

**`pithy add` writes `PUBLIC_ORIGIN` for you**, unquoted, for every option whose manifest says its value is an origin — `auth.baseURL` and `email.baseUrl` today. A `--set` override still wins, because a Worker fronted by something Pithy does not know about has an origin no derivation can produce. And a project scaffolded before the constant existed keeps the manifest's literal rather than being handed an identifier nothing defines; `pithy upgrade` starts writing the constant the day the declaration lands.

Name it for the Worker, not for the capability that asked first. The first project to write this called it `AUTH_BASE_URL`, and that is part of why `email` and `payments` kept their hardcoded URLs for days — the constant read as auth's private business when it is the Worker's address.

**An environment absent from `domains` resolves to `http://localhost`, never to another environment's origin.** An undeclared environment is an unpublished one, and the only unpublished environment is the local one — so the fallback fails closed: a link that goes nowhere, which is useless rather than harmful. A *deployed* environment must never keep it, and it cannot: `pithy deploy --env <name>` refuses an environment whose config declares no origin, and `pithy doctor` reports it first.

**One origin deliberately does not derive: `controlplane.issuer`.** It is an identity, not an address. A connection stores the issuer it was created with and verification checks that stored value, so a per-environment issuer would make a connection minted in staging unverifiable in production. That may well be the better isolation, but it is a decision about trust rather than about reachability — write it, do not derive it.

---

## 4. Help text

Help is **citty's everywhere but the root**. `pithy add --help` and every screen below it are rendered by citty's own `renderUsage` from the command tree in `packages/cli/src/main.ts`: the description line, the `USAGE` line, the `ARGUMENTS` / `OPTIONS` / `COMMANDS` blocks, the column alignment, and the closing pointer. The root screen — bare `pithy`, `pithy -h`, `pithy --help`, and the screen after an unrecognised name — is `packages/cli/src/help/rootUsage.ts`, because it groups its commands under headings and a heading is a thing we style (§4.3). Below the root, Pithy writes the copy and citty writes the layout. So the brevity rules bind where we actually hold the pen — each command's `meta.description` and each argument's `description` is one line, sentence case, no period unless it is a full sentence.

The two transcripts below are captured from the real binary and pinned by `packages/cli/src/binDocs.test.ts`. Reword a description in `main.ts`, add a command, or add a flag, and that test fails until this section is recaptured. `v<version>` stands in for the installed version — the one part of the output that varies.

**A command that names no action is asking what it can do, and being answered is a success.** One rule, at every level: bare `pithy` prints the command list and exits 0, and so does a group with no subcommand — `pithy secrets`, `pithy worker`, all fourteen. Nothing is printed after the help, because the list *is* the answer to the missing command; repeating it as a complaint is the CLI arguing with a user it has just served. Exit 0 is what makes `pithy && next` and a bare invocation in a CI step work, and it is what keeps `bun run pithy` from adding `error: script "pithy" exited with code 1` under a successful help screen.

A name that is **not** a command is a different thing. `pithy nonsense` is a mistake, not a question: it names what was not recognised, shows the help, and exits non-zero.

**And a name is a command only when the tree declares it.** Every `subCommands` is an object literal, so `Object.prototype` used to be in scope for every lookup at every level: `pithy valueOf` called `Object.prototype.valueOf` with no receiver and died on a raw `TypeError` under a crash banner, and `pithy constructor` called `Object`, took the `{}` it returned for a command definition, ran nothing, and exited **0**. `ownNamesOnly` in `dispatch.ts` copies each record onto a null prototype on its way to citty, so an inherited name resolves to nothing and takes the `pithy nonsense` path — named, help shown, non-zero. Done once, for the whole tree, and lazily: a subcommand thunk is wrapped, never called.

The rule lives in `packages/cli/src/dispatch.ts`, once, and is applied before citty parses — citty throws `E_NO_COMMAND` for the root and for every group, and `runMain` catches every such error into usage plus the message plus `process.exit(1)`. A group added later inherits the rule with nothing to remember.

### 4.1 Top-level help

`-h` / `--help` resolves to the root, and `bin.ts` answers it with the screen below before citty parses; a `--help` one level down is still citty's builtin. `-v` / `--version` is answered by `bin.ts` too, because citty's builtin only fires when the flag is the sole argument (§1.2). Both work, neither is listed under `OPTIONS`, and `--version` prints the bare version and nothing else. There is no `Docs:` footer; the screen closes with a pointer at per-command help. Bare `pithy` prints this same screen and exits 0, and so does `pithy nonsense` — with the name it did not recognise on stderr, and a non-zero exit.

```
$ pithy --help
A backend kit for Cloudflare Workers. (pithy v<version>)

USAGE pithy <command> [OPTIONS]

COMMANDS

  Project
       init    Scaffold a new project
        add    Add a capability
     remove    Remove a capability — the manual, interactive inverse of add
     worker    Manage the project's Workers under apps/ (the dev/deploy registry)
         ui    Scaffold and wire a front end served by one of the project's Workers
    upgrade    Reconcile each worker's installed capabilities with its pithy.config.ts and wrangler.jsonc

  Develop
        dev    Run every worker locally under one supervisor
    migrate    Run migrations for an environment
       seed    Seed an environment from your Zod-typed fixtures
    feature    Set up and tear down an isolated, fully-provisioned feature environment

  Operate
  provision    Create an environment's own Cloudflare resources, wire them into each Worker, then migrate
     deploy    Deploy to Cloudflare Workers
        env    Inventory every worker's environments: bindings, ids, provisioned state, dashboard links
      token    Mint and manage scoped Cloudflare API tokens
  dashboard    Connect, rotate, revoke, and inspect a management client (control-plane seam)

  Capabilities
    secrets    Manage encrypted secrets
      email    Provision and manage the email infrastructure
      media    Provision and manage the media infrastructure
   payments    Provision the reconciliation Workflow, and run a pass on demand
    storage    Provision and manage the storage infrastructure
    support    Provision and manage the support inbox infrastructure
    testers    Run a closed test: cohorts, roster, the clock, and the daily pass
  turnstile    Provision and manage Turnstile widgets
     vector    Provision, reset, and re-embed the vector indexes

  Toolchain
     doctor    Check the toolchain, project, and for a new CLI version
      alias    Install the `p.` shortcut for `pithy`

Use pithy <command> --help for more information about a command.
```

### 4.2 Subcommand help

Same renderer, one command deep. `pithy add` is the representative case — a positional argument and seven flags. Help never enumerates the capability catalog: `pithy add --list` is the command for that (§3.5), and it reads the installed set, which no static block can.

```
$ pithy add --help
Add a capability (pithy add v<version>)

USAGE pithy add [OPTIONS] [CAPABILITY]

ARGUMENTS

  CAPABILITY    Capability name, e.g. auth

OPTIONS

                --list    List the capabilities you can add (Default: false)
     --worker=<worker>    Which worker to wire it into (apps/<name>)
           --set=<set>    Override a config option: --set key=value (repeatable)
               --eject    Copy the capability's source into your repo and own it (no upgrades) (Default: false)
               --force    With --eject, overwrite an existing local copy (discards edits) (Default: false)
  --with-prerequisites    Compose the capabilities this one requires, if they aren't composed yet (Default: false)
                --json    Machine-readable output (Default: false)
```

### 4.3 Color in help

**The root screen is ours. Every screen below it is citty's.** Bare `pithy`, `pithy -h`, `pithy --help` and the screen after an unrecognised name all resolve to the root, and `bin.ts` renders that one itself through `help/rootUsage.ts` — the group headings are the reason, and a heading is a thing we style. Nothing else moved: `pithy add --help`, `pithy secrets`, and every group screen are still citty's `renderUsage`, byte for byte.

So the table splits in two.

The root screen, rendered through `src/terminal/style.ts` and therefore bound by §3.4:

| Element | Tier | Whose choice |
|---|---|---|
| Group headings | Basic-16 magenta + bold | Pithy |
| Section labels (`USAGE`, `COMMANDS`) | Bold | Pithy |
| Command names (left column) | Basic-16 cyan | Pithy |
| Descriptions (right column) | Default foreground | Pithy |
| The description line, `(pithy v<version>)` included | Dim attribute | Pithy |
| `pithy <command> --help` in the closing line | Basic-16 cyan | Pithy |

Every subcommand screen, rendered by citty, which consults none of that:

| Element | Rendered as | Whose choice |
|---|---|---|
| The description line, `(pithy add v<version>)` included | Gray | citty |
| Section labels (`USAGE`, `ARGUMENTS`, `OPTIONS`, `COMMANDS`) | Bold + underline | citty |
| The usage line after `USAGE` | Cyan | citty |
| Argument names, flag names, command names (left column) | Cyan | citty |
| Descriptions (right column) | Default foreground | citty |
| The `(Default: …)` and `(Required)` hints | Gray | citty |
| `pithy <command> --help` in the closing line | Cyan | citty |
| Every word of copy inside those columns | — | Pithy |

The root screen keeps citty's shapes on purpose — the same right-aligned name column, the same four-space gutter, the same closing pointer — because the two screens sit one keystroke apart and a root screen that repainted itself would read as a different program. That is also why §3.5's two-space rule does not reach it. One difference is deliberate: citty's gray is our dim, which is §3.4's tier for muted text and renders correctly against a light theme where gray does not.

**Piped, both go plain — and that is a translation, not an agreement.** The root screen reads §3.4: `NO_COLOR` at any value off, `FORCE_COLOR` on, otherwise `isTTY`. citty reads a private flag latched at import from `NO_COLOR === "1" || TERM === "dumb" || TEST || CI`, and consults nothing else — not `isTTY`, not `FORCE_COLOR`, not `NO_COLOR=0`. `bin.ts` bridges the two in one direction: when Pithy's rule says color is off, it sets `NO_COLOR=1` before citty is loaded. So `pithy --help | cat` and `pithy add --help | cat` are both plain, and neither writes an escape code into something being parsed.

**The reverse is left alone, and that is where the two screens diverge.** With `CI` set, or `TERM=dumb`, on a terminal Pithy calls color-capable, Pithy says on and citty says off: the root screen carries color and every subcommand screen does not. Closing it would mean deleting `CI` from the environment of this process and of every wrangler and bun the CLI spawns — a far larger lie than an uncolored screen in a CI log. The divergence stays, in the direction that cannot corrupt anyone's output.

Column alignment is citty's, and the root screen copies it: each column pads to its widest cell, never to the terminal, so help looks identical at any width and the left column is right-aligned. Nothing in either renderer reads `process.stdout.columns`, which is what lets `binDocs.test.ts` pin both screens byte for byte and get the same answer on every machine.

There is still no saffron in help, and no banner. Group headings carry the structure; saffron carries meaning, and "which section is this" is structure. The wordmark belongs on the website, not in the terminal.

---

## 5. Update notifications

Pithy checks for new CLI versions in the background, notifies the user when one is available, and never auto-updates anything.

### 5.1 Cadence

- Background check at most once every 24 hours
- Result cached in `~/.config/pithy/state.json` (POSIX) or `%APPDATA%\pithy\state.json` (Windows)
- Cache contents: last-check timestamp, latest known version, detected installer, notifier opt-out state
- The check fires off-thread via `setImmediate` after the current command's primary work completes — it never blocks command execution

The registry query:

```
GET https://registry.npmjs.org/@pithy-sh%2Fcli/latest
```

If the request fails (offline, network issue, registry hiccup), Pithy silently keeps using the cached value. Update checks are non-essential; they must never break the actual CLI.

### 5.2 Notification output

Notifications are written to **stderr** (never stdout) at the end of any successful command, after `Done.`:

```
$ pithy add auth
▸ Installing @pithy-sh/auth...
▸ Updating wrangler.jsonc...

Done.

pithy 1.3.0 available. You have 1.2.0.
Update: bun update -g @pithy-sh/cli
```

The word `available` and the new version number render in saffron when color is supported. Everything else uses the dim/default conventions from Section 3.4.

Conditions for showing the notification:

- stderr is a TTY (don't pollute piped output or CI logs)
- `PITHY_NO_UPDATE_NOTIFIER` is unset
- A newer **minor or major** version exists (patch versions are suppressed unless flagged)

For **major** version bumps, the notification adds a changelog pointer:

```
pithy 2.0.0 available. You have 1.4.0. (Major release — see changelog.)
Update: brew upgrade pithy
Changelog: https://pithy.sh/changelog/2.0
```

For **patch** version bumps (`1.2.0` → `1.2.1`), notifications are **suppressed** unless the release is flagged with `pithy:security` in its release metadata. Patch noise trains users to ignore notifications; reserving the surface for meaningful updates keeps it useful.

Version comparison comes from `parseSemver` and `compareSemver` in `@pithy-sh/core/src/semver/semver` — the same primitive any capability ranking versions uses. The notifier then **narrows** it: `parseVersion` keeps `major.minor.patch` and drops the prerelease, so `1.3.0-rc.1` and `1.3.0` are the same version here and nobody on the stable channel is nagged about a release candidate. The narrowing lives in `packages/cli/src/notifier/version.ts`, not in the primitive, because the notifier is the only caller that wants it.

### 5.3 Installer detection

Pithy detects which package manager installed the binary by inspecting `process.argv[1]`. The detection is path-based:

```ts
type Installer = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'brew' | 'unknown';

function detectInstaller(): Installer {
  const binPath = (process.argv[1] || '').replace(/\\/g, '/');

  if (binPath.includes('/.bun/')) return 'bun';
  if (binPath.includes('/.deno/')) return 'deno';
  if (/\/pnpm\/|\/\.pnpm\//.test(binPath)) return 'pnpm';
  if (/\/(?:home|linux)brew\/|\/Cellar\//.test(binPath)) return 'brew';
  if (/\/\.yarn\/|\/yarn\/global\//.test(binPath)) return 'yarn';
  if (/\/npm\/|\/node_modules\//.test(binPath)) return 'npm';

  return 'unknown';
}

function upgradeCommandFor(installer: Installer): string {
  switch (installer) {
    case 'bun':  return 'bun update -g @pithy-sh/cli';
    case 'pnpm': return 'pnpm update -g @pithy-sh/cli';
    case 'yarn': return 'yarn global upgrade @pithy-sh/cli';
    case 'deno': return 'deno install --reload -g -A -n pithy npm:@pithy-sh/cli';
    case 'brew': return 'brew upgrade pithy';
    case 'npm':
    case 'unknown':
    default:     return 'npm i -g @pithy-sh/cli';
  }
}
```

The detection runs once and is cached in the state file. Unknown installs default to `npm` — anyone with Node has npm, so the fallback is universal.

### 5.4 Homebrew tap

Homebrew users — a significant segment of macOS developers — install via a separate tap repo: **`pithy-sh/homebrew-tap`**.

The tap contains a single Ruby formula:

```ruby
# pithy-sh/homebrew-tap/Formula/pithy.rb
class Pithy < Formula
  desc "Cloudflare-native backend kit"
  homepage "https://pithy.sh"
  url "https://registry.npmjs.org/@pithy-sh/cli/-/cli-#{version}.tgz"
  sha256 "..."  # computed at release time
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "-g", "--prefix", libexec, "@pithy-sh/cli"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match(/pithy/, shell_output("#{bin}/pithy --version"))
  end
end
```

User-facing commands:

```
brew install pithy-sh/tap/pithy
brew upgrade pithy
brew uninstall pithy
```

The formula is updated automatically by a GitHub Actions workflow on every `@pithy-sh/cli` npm release:

1. Triggers on `release.published` for `pithy-sh/cli`
2. Computes the SHA-256 of the new npm tarball
3. Opens a PR on `pithy-sh/homebrew-tap` updating the formula's `url` and `sha256`
4. Auto-merges if `brew test` passes against the new formula

This keeps Homebrew users on the same release cadence as npm users with no manual formula maintenance.

### 5.5 Opt-out

Users can disable the update notifier in three ways:

| Method | Persistence |
|---|---|
| `PITHY_NO_UPDATE_NOTIFIER=1` env var | Per-shell, or persistent if added to rc file |
| `pithy doctor --disable-notifier` | Persisted in state file |
| Edit `~/.config/pithy/state.json` and set `"notifier": false` | Persisted in state file |

The corresponding `pithy doctor --enable-notifier` re-enables it.

### 5.6 The `pithy doctor` command

Moved to [`docs/commands/doctor.md`](commands/doctor.md).

**One block of it is specified here because it is a contract other packages implement: `Settings:`.** Every other check doctor runs asks whether something is *present* — the option key, the binding, the migration. None of them looks at the value, so a project stays green while `fromAddress` names a domain nobody onboarded and `BASE_URL` points at a host nothing serves.

A capability declares its own settings check on its `Capability` object, beside `health`. **Discovery keys on the composed instance and never on `pithy.manifest.json`** — two published capability packages ship no manifest, and a manifest-keyed rule skips both in silence. Doctor runs it for every capability every Worker under `apps/` composes, with no capability named on the command line; `--worker <name>` narrows it exactly as it narrows the health block. A capability that declares nothing is skipped, silently, and that is not a fault.

Two tiers, because they cost different things:

| Tier | Asks | Cost |
|---|---|---|
| `local` | Does the value parse, is it the right shape, is it right for this environment. Validated through **the same Zod object the capability's host Worker validates at boot** — one schema, two readers. | Free, offline, always run. |
| `account` | Is the domain a zone here, does the secret have a value, is the database there. | One Cloudflare call, on the credentials this report already resolved. |

**What makes `doctor` fail:** a finding from either tier. A local finding is established from the project's own files. An account finding is established from an account that answered — so the exit gate reads the findings, never the tier's state. When the account cannot be reached (offline, no credentials, no answer) the tier is reported as **skipped**, with the reason, and gates nothing; a capability whose check threw is reported as **unchecked**, with the tier that failed. Neither is ever rendered as a pass. Every finding renders as a problem line and an action line naming the `pithy` command, config key, or one-time account action that resolves it, and every finding and every skip appears in `--json`. The check never writes anything.

### 5.7 Project capability updates

Distinct from CLI updates. When run inside a Pithy project, the doctor command reports outdated capability packages alongside the CLI version. Two upgrade paths, two distinct commands:

| To update... | Run... |
|---|---|
| The Pithy CLI binary | The installer-specific command (e.g., `npm i -g @pithy-sh/cli`, `brew upgrade pithy`) |
| Project capabilities | `pithy upgrade` |

These are intentionally separate. The CLI binary version is one concept; a project's capability versions are another. Conflating them would confuse the upgrade story and produce ambiguous commands.

**Both capability commands report the manifests they could not read.** An installed `@pithy-sh/*` package whose `pithy.manifest.json` will not parse is a capability that vanishes from every plan, and a run that reconciled happily around the hole reported nothing at all. `pithy upgrade` prints the faults above the Workers, once, because manifests resolve from the project root and no Worker owns one; `pithy add --list` names them on stderr after the catalog, since a package it cannot read is one it cannot tell you is installed. Reported, never refused: one broken package must not cost an adopter the other fifteen entries. Neither command can fix it — the file belongs to somebody else's package.

**What `upgrade` reports is what it wrote.** The count comes back off the writer, one entry per binding actually appended to a stanza, and a binding the writer could not compose an entry for is **named, with the reason**, rather than folded into a count:

```
board:
  payments: added 1 config key.
  payments: PAYMENTS_RECONCILE (workflow) not written for dev — PAYMENTS_RECONCILE declares no job.
```

That line is the difference between `upgrade` and `doctor` agreeing and not. Reporting the *plan* instead is what made `upgrade` say "added 3 bindings" over a `wrangler.jsonc` it had left untouched, while `doctor` — run seconds later, against the same tree, through the same plan builder — correctly still called them missing.

`pithy upgrade --json` carries five fields. `command` is the command's name, `env` the environment the pending-migration count was computed for, and `dryRun` whether anything was written. `workers` is one entry per Worker in discovery order, each holding the `plan` built for it and the `applied` result of writing it — `null` on a dry run. Each applied capability carries `addedBindings` (what landed) and `skippedBindings` (what did not, each with its `reason`). `manifestFaults` is the project-wide list, one entry per unusable manifest, each naming its `package` and the `reason`.

`pithy add --list --json` carries three. `command`, then `capabilities` — the catalog, each entry naming the capability, its package, when to enable it, and whether this project has it installed — and the same `manifestFaults` list, for the same reason and in the same shape.

```
$ pithy add --list --json
{"command":"add","capabilities":[{"name":"auth","package":"@pithy-sh/auth","whenToEnable":"Authentication and session management.","installed":true}],"manifestFaults":[{"package":"@pithy-sh/leaderboard","reason":"configOptions[0].key: not a bare identifier"}]}
```

### 5.8 Testing checklist

- [ ] Update check never blocks command execution
- [ ] Network failure during check is silent; cached value continues to be used
- [ ] `NO_COLOR` disables the saffron accent on the notification
- [ ] `PITHY_NO_UPDATE_NOTIFIER` suppresses the notification entirely
- [ ] Non-TTY stderr (piped, CI) suppresses the notification
- [ ] Patch version bumps don't trigger notifications (unless flagged)
- [ ] Installer detection returns correct command for npm, pnpm, yarn, bun, deno, brew
- [ ] Unknown installer falls back to `npm i -g @pithy-sh/cli`
- [ ] `pithy doctor` always performs a fresh check, bypassing cache
- [ ] Homebrew tap formula updates automatically on npm release
- [ ] `pithy doctor --disable-notifier` persists across runs

---

## 6. Local dev orchestration (`pithy dev`)

Moved to [`docs/commands/dev.md`](commands/dev.md).

§6.5 and §6.6 stay. They specify `pithy worker`, not `pithy dev`, and [`docs/commands/worker.md`](commands/worker.md) cites them.

### 6.5 Reconciling a Worker's declaration (`pithy worker sync`)

```
pithy worker sync [--worker <name>] [--env <environment>] [--json]
```

A library capability's Workflows are provisioned: `pithy <capability> provision` deploys the host Worker and writes the cross-script binding into the app's `wrangler.jsonc`. A Workflow the **adopter's own app capability** declares had no such path, so its `workflows` array, its `triggers.crons`, and the repetition of both across every environment were written by hand — against `<project>-<env>-<capability>-<job>` and Cloudflare's segment rule, neither of which fails until deploy.

`pithy worker sync` writes them. It reads the Worker's `app` capability, derives each job's name through the same helper the kit uses for a library capability's, and reconciles the result into `wrangler.jsonc`: the top-level stanza and every `env.<name>` the Worker already declares, or just the one `--env` names. It touches no Cloudflare account and runs no deploy.

**It writes the Worker's address the same way**, from the same file. A `domains` block names where the Worker answers per environment, and the `custom_domain` route and `vars.BASE_URL` it implies are generated from it — by `pithy init`, by `pithy worker add`, and by this command. That last one is the one that was missing: the first two only ever write the route from an interactive prompt, so a `domains` block added by hand declared an address nothing served, and `pithy doctor` and `pithy deploy` both reported it healthy while the Worker answered on nothing. Doctor names this command when it reports that fault.

**And `pithy doctor` and `pithy deploy` read it back.** Writing was only ever half of it: a declaration nothing reconciles is a cron that never fires, and until the reader existed nothing anywhere noticed. Doctor reports a stanza that does not bind what the app declares, `pithy deploy --env <name>` refuses it, and both name this command (`docs/commands/doctor.md`).

Three rules govern what it writes:

- **The app's entries are replaced, not merged.** A job renamed or dropped leaves — including the last one, so an app that declares no Workflows still has its stale bindings and crons taken out. An entry carrying a `script_name` belongs to a library capability's provisioner and is never touched.
- **`triggers.crons` is set to the declared schedules.** A Worker has one `scheduled` handler and it starts *every* job that declares a schedule, whatever cron fired — so an expression nothing declares is not an extra job, it is every job running again at a time nobody asked for.
- **The class stays yours.** Cloudflare resolves `class_name` in the script the binding names, so the `WorkflowEntrypoint` subclass has to be exported from the Worker's `main`. That is five lines written once; the command names the classes it expects.

Idempotent, comment-preserving, and all-or-nothing: a run with nothing to change reports that nothing moved, and a stanza wrangler would reject aborts the run rather than leaving half a config behind.

### 6.6 Renaming a worker (`pithy worker rename`)

```
pithy worker rename <old> <new> [--force] [--json]
```

**A worker's name is not one string. It is three, and they have to agree.**

- the directory, `apps/<name>/`, which tsconfig references and CI `working-directory` keys point at;
- the deployed script name, in `wrangler.jsonc` and the worker's `package.json`;
- `vars.WORKER`, which is what tells two Workers' audit events apart when they share a database.

Renamed by hand — `git mv`, then the edits — whichever one is missed fails quietly, and in the worst shape a failure takes: the Worker deploys under one name and stamps its events with another, so the audit trail names a Worker that did not act. `pithy worker rename` moves all three at once, comment-preserving, holding the new name to the same kebab-case rule `pithy worker add` holds a new one to and refusing a destination that already exists.

Two things it deliberately leaves alone. The **app capability's `name`** in `pithy.config.ts` is a migration namespace, stamped into every applied migration's row — moving it orphans the ledger and re-runs every migration under a name the database has never seen. And a **script name the adopter chose**: `<project>-<worker>` is what the scaffold writes, so only a name carrying the worker segment is recomputed. A Worker migrated in as `my-service` keeps its name, and the command says so.

**A rename after a deploy is not a rename.** Resource names are computed rather than stored, so `<project>-<env>-<binding>` survives untouched — but the Worker script is named for the worker, so a renamed worker deploys as a *new* script and leaves the old one live, serving, and billing. So the account is asked first, and a live script under the old name is refused by name. `--force` is how you say it is understood; the report then names exactly what was left behind. Where the account cannot be reached — no credentials, an offline laptop, a token that will not list — the rename proceeds and says it did not check. It never reports an unchecked account as a clear one.

What it does not touch is everything outside the worker's own directory: the root `tsconfig.json` references, a vitest config, a CI workflow. Those are yours, they are grep-able, and the command's last line says to look. `pithy doctor` checks the three stamps agree on every run ([`commands/doctor.md`](commands/doctor.md)), so a hand-rename that misses one fails CI instead of a deploy.

---

## 7. Front ends (`pithy ui`)

Moved to [`docs/commands/ui.md`](commands/ui.md).

---

## 8. Data seeding (`pithy seed`)

Moved to [`docs/commands/seed.md`](commands/seed.md).

---

## 9. Cross-platform notes

- **Path handling:** Use `node:path` for all path joins; never concatenate strings. Windows paths must work.
- **Line endings:** Write `\n` on POSIX, `\r\n` on Windows. Detect via `os.EOL`.
- **File permissions:** Created rc files get `0644` on POSIX; on Windows, default ACLs.
- **Terminal width:** Detect via `process.stdout.columns`; fall back to 80 if undefined.
- **TTY detection:** Use `process.stdout.isTTY` to enable color and interactive prompts. Non-TTY (piped) output must be plain text and parseable.

---

## 10. Future expansions

This document covers v1, which ships the full alias system, update notifications with installer detection, the Homebrew tap, the `doctor` command, and the `dev` orchestrator. Areas to formalize in v1.1+:

- `pithy plugin` — third-party capability installation
- `pithy logs` — tail Workers logs via the customer-deployed admin Worker
- `pithy secrets` — cross-environment secret management
- Telemetry opt-in/out (mirroring the `pithy alias` install flow)
- Self-update command (`pithy self-update`) — currently we suggest the installer-specific command rather than running it

Each new command should be reviewed against this document's principles: verb-noun shape, concise output, deliberate periods, no jargon, never write to user files without consent.
