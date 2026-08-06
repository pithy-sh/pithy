# Pithy CLI Specification

> The CLI is the brand's primary interface. Every command, every flag, every output line should feel like Pithy — short, deliberate, and confident. This document specifies behavior. For visual identity, voice, and color tokens, see `BRAND.md`.

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
| `pithy add <capability> [--worker <name>]` | Install a capability (auth, leaderboard, storage, vector) — installs the package, wires it into **that Worker's** `apps/<name>/pithy.config.ts` and `wrangler.jsonc`, scaffolds its **config** (you pick the mount path; handler source stays in the package), and runs its migrations. `--eject` copies the source into your repo — the only path that writes handler source (see `docs/EJECT.md`) |
| `pithy remove <capability> [--worker <name>]` | The manual, interactive inverse of `add` (and `add --eject`): unwires that Worker's config + bindings and uninstalls the package (or deletes the ejected source), leaving your data untouched unless you pass `--drop`. **Manual-only — `--json` is rejected** (see below) |
| `pithy worker <add\|list\|remove\|rename\|sync> [name]` | Manage the project's Workers under `apps/<name>/`; `apps/` is the registry every command discovers (see Section 6). `rename` moves the directory and the two other places a Worker's name is stamped (see Section 6.6). `sync` writes the Worker's **app-declared** Workflows and cron triggers into its `wrangler.jsonc`, for every environment it declares — the app's equivalent of what `pithy <capability> provision` writes for a library capability's (see Section 6.5) |
| `pithy ui <add\|sync\|list> [--worker <name>]` | Scaffold a front end into an existing Worker and wire it end to end — Vite, the SPA entry, the routes, the `assets` stanza, the dev command. `sync` re-derives the asset routing after the Worker's capabilities change; `list` reports which Workers carry a UI (see Section 7 and `docs/UI.md`) |
| `pithy dev` | Start the local development environment (multi-worker, per-feature ports — see Section 6) |
| `pithy migrate [--worker <name>]` | Run each Worker's migration registry against an `--env` (`--rollback` to downgrade). Fans out over every Worker; Workers sharing a database migrate it once |
| `pithy seed [--worker <name>]` | Load seed/test data (same Zod schemas/codecs) for local dev or ephemeral CI — see Section 8 and `docs/SEED.md` |
| `pithy feature` | Feature environment lifecycle: `create` (local worktree, ports, migrate + seed), `sync` (make an existing worktree ready), `provision` (its ephemeral CF resources), `destroy` (tear it all down) |
| `pithy env [--worker <name>]` | Report each Worker's deployment environments (`dev`/`staging`/`prod`), their bindings, resolved ids, and dashboard links — read-only, switches nothing |
| `pithy dashboard <connect\|rotate\|revoke-key\|disconnect\|status>` | Register, rotate, revoke, and inspect a management client's access to this project — project-wide and **per environment**, never per Worker. `connect` resolves the Worker's address and the seam's base path from the project (it prints both and where they came from; `--worker-url` overrides, and `--worker <name>` is required when a project has several Workers), runs a browser device-code flow, writes the trusted public key into your own D1, and reports connected only once a signed ping round-trips; `--public-key` registers a key you generated yourself, with no dashboard involved. `revoke-key` pulls one leaked key and leaves the connection standing; `disconnect` removes the lot. Both are local, immediate, and need nothing from the client. See `docs/CONTROL-PLANE.md` |
| `pithy deploy` | Deploy to Cloudflare Workers. A Worker carrying a UI builds it first — its manifest's `ui.build`, then `wrangler deploy` (see Section 7) |
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

**`--env` takes `dev`, `staging`, or `prod`, and it is validated at the flag.** It defaults to `dev`, because every command is safe there. It is **not** `production`: the environment sits verbatim in the middle of every Cloudflare name the project composes, so each of its characters costs one character of project name, one for one — and `--env production` is answered with an error naming `prod`. A custom environment is allowed (`live`, `eu-prod`), held to the same charset and to a hard maximum of 7 characters, the length of `staging`. Every project-name budget is derived against that 7, and a provisioned project cannot be renamed, so a longer environment is refused rather than quietly shrinking a cap projects were already accepted under. See `docs/NAMING.md`.

Every command is agent-drivable and supports `--json`, with **one deliberate exception**: `pithy remove` is destructive, so it is **manual, interactive-only** — passing `--json` fast-fails with a clear error before anything changes. Its `--drop` confirmations are typed at a real terminal; there is no headless path. Automated teardown of an ephemeral environment is a different command (the `feature` lifecycle), not `remove`.

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
| Terminal-themed attributes | `\033[2m` (dim) | The user's terminal renders dim text against any theme correctly; no override of their colors |
| Terminal-themed basic-16 | `\033[31m`, `\033[33m`, etc. | The user's terminal defines what "red" looks like; works on light and dark themes equally |
| Truecolor (24-bit RGB) | `\033[38;2;R;G;Bm` | Exact color; used only when Pithy's brand color must remain constant |

Element-to-tier mapping:

| Element | Tier | Reason |
|---|---|---|
| Status arrow `▸`, primary text | None (default foreground) | Inherits terminal foreground; readable in any theme |
| Muted text (descriptions, paths, package names, section labels) | Dim attribute | Reads as secondary against any background |
| Error text | Basic-16 red | User's terminal defines red; respects their theme |
| Warning text | Basic-16 yellow | Same reasoning |
| Saffron brand accent | Truecolor `\033[38;2;212;160;23m` (#D4A017); fall back to 256-color 178; fall back to no color | Brand mark; must be the same color everywhere it renders |

Where saffron appears (and only here):

- The `.` in `Done.` after successful operations
- The period before `sh` in the docs URL footer of help output
- Loading spinner glyphs during long operations
- Update notification "available" indicator
- Nowhere else — saffron earns its place by carrying meaning

Color is automatically **disabled** when:

- `NO_COLOR` env var is set to any value ([no-color.org](https://no-color.org/) standard)
- `process.stdout.isTTY` is false (piped output, CI logs without override)
- The terminal reports zero color support

Color is **forced on** when:

- `FORCE_COLOR` env var is set
- The `--color` flag is passed to any command

Color is **forced off** when:

- The `--no-color` flag is passed (overrides everything else)

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

**Help is citty's, and citty decides color for itself.** It renders `--help` from its own private flag, latched at import from `NO_COLOR === "1" || TERM === "dumb" || TEST || CI` — not `isTTY`, not `NO_COLOR` set to any other value, not `FORCE_COLOR`. Left alone, `pithy --help | cat` writes escape codes into a pipe while every other surface goes plain. So `bin.ts` reads `colorEnabled()` and, when it is false, sets `NO_COLOR=1` before citty is loaded. That translation runs one way only: Pithy never deletes `CI` to force citty's color back on, because that would rewrite the environment of every child process the CLI spawns. Plain help in a CI log is harmless; ANSI in a pipe is not.

### 3.5 Tables and lists

For multi-row output (e.g., `pithy add --list`), use clean aligned columns with two spaces between, no border characters:

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

---

## 4. Help text

Help is **citty's**, not ours. `pithy --help` and every `<command> --help` are rendered by citty's own `renderUsage` from the command tree in `packages/cli/src/main.ts`: the description line, the `USAGE` line, the `ARGUMENTS` / `OPTIONS` / `COMMANDS` blocks, the column alignment, and the closing pointer. Pithy writes the copy; citty writes the layout. So the brevity rules bind where we actually hold the pen — each command's `meta.description` and each argument's `description` is one line, sentence case, no period unless it is a full sentence.

The two transcripts below are captured from the real binary and pinned by `packages/cli/src/binDocs.test.ts`. Reword a description in `main.ts`, add a command, or add a flag, and that test fails until this section is recaptured. `v<version>` stands in for the installed version — the one part of the output that varies.

### 4.1 Top-level help

`-h` / `--help` is a citty builtin; `-v` / `--version` is answered by `bin.ts` before dispatch, because citty's builtin only fires when the flag is the sole argument (§1.2). Both work, citty lists neither under `OPTIONS`, and `--version` prints the bare version and nothing else. There is no `Docs:` footer; citty closes with its own pointer at per-command help.

```
$ pithy --help
A backend kit for Cloudflare Workers. (pithy v<version>)

USAGE pithy init|add|remove|worker|ui|dev|migrate|seed|feature|env|deploy|upgrade|token|dashboard|secrets|email|media|payments|support|storage|testers|vector|turnstile|alias|doctor

COMMANDS

       init    Scaffold a new project
        add    Add a capability
     remove    Remove a capability — the manual, interactive inverse of add
     worker    Manage the project's Workers under apps/ (the dev/deploy registry)
         ui    Scaffold and wire a front end served by one of the project's Workers
        dev    Run every worker locally under one supervisor
    migrate    Run migrations for an environment
       seed    Seed an environment from your Zod-typed fixtures
    feature    Set up and tear down an isolated, fully-provisioned feature environment
        env    Inventory every worker's environments: bindings, ids, provisioned state, dashboard links
     deploy    Deploy to Cloudflare Workers
    upgrade    Reconcile each worker's installed capabilities with its pithy.config.ts and wrangler.jsonc
      token    Mint and manage scoped Cloudflare API tokens
  dashboard    Connect, rotate, revoke, and inspect a management client (control-plane seam)
    secrets    Manage encrypted secrets
      email    Provision and manage the email infrastructure
      media    Provision and manage the media infrastructure
   payments    Provision the reconciliation Workflow, and run a pass on demand
    support    Provision and manage the support inbox infrastructure
    storage    Provision and manage the storage infrastructure
    testers    Run a closed test: cohorts, roster, the clock, and the daily pass
     vector    Provision, reset, and re-embed the vector indexes
  turnstile    Provision and manage Turnstile widgets
      alias    Install the `p.` shortcut for `pithy`
     doctor    Check the toolchain, project, and for a new CLI version

Use pithy <command> --help for more information about a command.
```

### 4.2 Subcommand help

Same renderer, one command deep. `pithy add` is the representative case — a positional argument and six flags. Help never enumerates the capability catalog: `pithy add --list` is the command for that (§3.5), and it reads the installed set, which no static block can.

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
             --json    Machine-readable output (Default: false)
```

### 4.3 Color in help

**citty colors its own help, and Pithy does not touch it.** `src/terminal/style.ts` — the seam every other colored character in the CLI flows through (§3.4) — is not on this path, and there is no hook that would put it there short of replacing `renderUsage`. So this table describes what citty emits rather than specifying what we render:

| Element | Rendered as | Whose choice |
|---|---|---|
| The description line, `(pithy v<version>)` included | Gray | citty |
| Section labels (`USAGE`, `ARGUMENTS`, `OPTIONS`, `COMMANDS`) | Bold + underline | citty |
| The usage line after `USAGE` | Cyan | citty |
| Command names, argument names, flag names (left column) | Cyan | citty |
| Descriptions (right column) | Default foreground | citty |
| The `(Default: …)` and `(Required)` hints | Gray | citty |
| `pithy <command> --help` in the closing line | Cyan | citty |
| Every word of copy inside those columns | — | Pithy |

Help therefore does **not** obey §3.4, and the divergence is worth knowing before anyone files it as a bug. citty drops color for `NO_COLOR=1` **exactly** (not any value), `TERM=dumb`, or any `TEST` or `CI` variable, and consults nothing else — not `isTTY`, not `FORCE_COLOR`, not `--color` / `--no-color`. Piped help still carries ANSI; every other Pithy surface goes plain the moment it is piped.

Column alignment is citty's too, and it is a pure function of the command tree — each column is padded to its widest cell, never to the terminal — so help looks identical at any width, and the left column is right-aligned.

There is no saffron in help, and no brand moment. The period in `pithy.sh` earns its keep in copy we write; help is a surface we host rather than author, and one accent dropped into someone else's layout would mean owning the renderer.

No banners. No ASCII logos. The wordmark belongs on the website, not in the terminal.

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

`pithy doctor` is the user-initiated health check. It bypasses the 24-hour cache, performs a fresh registry query, and reports the full environment state:

```
$ pithy doctor

pithy 1.2.0 (installed via bun)
Update available: 1.3.0
Run: bun update -g @pithy-sh/cli

Shell: zsh (~/.zshrc)
Alias: installed (`p.` → `pithy`)

Config dir: ~/.config/pithy
State file: ~/.config/pithy/state.json
Notifier:   enabled (PITHY_NO_UPDATE_NOTIFIER to disable)

Project: pithy.config.ts found
Project capabilities:
  @pithy-sh/core         1.2.0 ✓
  @pithy-sh/auth         1.1.8 (1.2.0 available — run `pithy upgrade`)
  @pithy-sh/leaderboard  1.2.0 ✓

Project health:
  api:
    config       parses against every capability schema ✓
    bindings     MEDIA_BUCKET (r2) missing from wrangler.jsonc
                 env: staging, prod
    migrations   2 pending — run: pithy migrate --env dev
    entitlements no gated route without a provider ✓
  collab: healthy ✓

Cloudflare: reachable (token active)

Project name: acme — every resource name matches

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

The **`Project health`** block is `pithy upgrade`'s manifest-versus-wiring comparison in read-only mode —
one engine, two commands: doctor reports drift, upgrade fixes it. It is reported **per Worker**, since each
Worker under `apps/` carries its own `pithy.config.ts` and `wrangler.jsonc` and so drifts independently; a
healthy Worker collapses to one line, and the whole block is omitted when every Worker is healthy. **Doctor
exits non-zero when any Worker fails a check**, so CI can gate on it. Nothing else in the CLI tells you a
required binding is missing before deploy does.

The **`Cloudflare:`** line answers "can I reach the account" — the bootstrap `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` pair, verified against Cloudflare rather than merely read (`docs/TOKENS.md`). A configured-but-broken credential fails the exit; an absent one does not, because a project that has not been provisioned yet is a legitimate state.

The same line warns when the pair **came from two places**. The `.dev.vars` overlay works per key, so a file that sets only `CLOUDFLARE_API_TOKEN` silently takes `CLOUDFLARE_ACCOUNT_ID` from whatever the shell exports — one account's token against another account's id, and nothing disagrees for anything to catch. What you get is a confusing 403, or an empty listing, at some much later call. Doctor names which key came from the file and which from the environment, and this one line is all it adds: an otherwise clean report stays terse. It checks that one source decided the pair, not that the pair is right — a complete `.dev.vars` naming the wrong account is coherent, and coherent is all this can judge. Reported, never gated: the credentials may well work. A complete `.dev.vars`, a shell exporting a different account's whole pair over it, and CI (which has no `.dev.vars` at all) are all silent.

The **`Project name:`** line answers the next question: is what I would find there still mine. Every resource this project provisions leads with the root config's `name` (`docs/NAMING.md`), and teardown *recomputes* those names rather than scanning for them — so one edit to `name` orphans everything while every command keeps exiting 0. Doctor requires positive evidence before it says so, because `<app>-<env>-<resource>` is also the ordinary Cloudflare convention and a database you brought with you is not an orphan. Two states fail the exit: **drifted**, where the wiring contradicts the config wholesale (every declared name leads with one and the same other project, and the configured name appears nowhere — the only shape a one-string rename can leave), and **orphaned**, where a database's `pithy_migrations_owner` stamp proves Pithy created it under another project's name. Neither state ever advises deleting a resource. A single foreign name, a mix, an unset name, and an unreadable `wrangler.jsonc` all pass — none of them establishes anything.

Both lines appear in the verbose report only, with the one exception above — a split credential pair prints its `Cloudflare:` line without making the rest of the report verbose. A clean pass on each is otherwise a precondition of the terse form, so their absence below is the report saying they passed.

A **`Worker names:`** block appears when a Worker's three names stop agreeing — its `apps/<dir>`, the deployed script name in its `wrangler.jsonc`, and its `vars.WORKER`. It is the hand-rename check: `git mv apps/api apps/board` and one forgotten edit leaves a Worker deploying under one name and stamping its audit events with another, and nothing else in the toolchain notices. Shown per Worker, one line per stamp that disagrees, and it **fails the exit** — the contradiction is between this repo's own directory and its own config, so it is established from local files alone and no account is consulted. Held to the same evidence bar as `Project name:`: a script name that was never composed from `<project>-<worker>` was brought in from somewhere, not renamed, and passes. `pithy worker rename` (§6.6) is what moves all three at once.

When everything is up to date, the output is correspondingly terser:

```
$ pithy doctor

pithy 1.3.0 (installed via brew)
Up to date.

Shell: zsh
Alias: installed

Project: pithy.config.ts found
Project capabilities: all up to date

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

`Runtime:` names the interpreter actually executing. Under Bun, `process.versions.node` is the Node version being emulated, so reporting it alone would name a runtime that is not running — the one thing a diagnostic must not do. On Node it reads `Runtime: Node 22.10.0`, with no compat suffix.

Outside a Pithy project directory, the `Project:` line states the one fact — there is no `pithy.config.ts` here, so run `pithy init` or change to a project directory — and every other project line is omitted, `Project name:` included. With no project there is no name to reconcile, and a second line answering that question is how doctor came to advise adding a key to a file that does not exist. The exit stays 0 and the report stays terse when the toolchain is clean: checking the CLI version, the shell, or the alias from anywhere is legitimate, and someone doing it is asking about their toolchain, not their project.

```
$ cd /tmp && pithy doctor

pithy 1.3.0 (installed via brew)
Up to date.

Shell: zsh
Alias: installed

Project: no pithy.config.ts here — run `pithy init`, or change to a project directory

OS:      macOS 14.5
Runtime: Bun 1.2.4 (Node 22.10.0 compat)
```

The `Cloudflare:` check still runs there: `.dev.vars` is read from the directory either way, and "are my credentials right" is worth answering before `pithy init` as much as after.

### 5.7 Project capability updates

Distinct from CLI updates. When run inside a Pithy project, the doctor command reports outdated capability packages alongside the CLI version. Two upgrade paths, two distinct commands:

| To update... | Run... |
|---|---|
| The Pithy CLI binary | The installer-specific command (e.g., `npm i -g @pithy-sh/cli`, `brew upgrade pithy`) |
| Project capabilities | `pithy upgrade` |

These are intentionally separate. The CLI binary version is one concept; a project's capability versions are another. Conflating them would confuse the upgrade story and produce ambiguous commands.

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

`pithy dev` runs the whole backend — every Worker in `apps/`, plus any web frontend — under one supervising process, so a developer never hand-juggles terminals or ports. It ports the proven CMS `scripts/dev.ts` design.

### 6.1 What it does

- **Discovers workers from `apps/`.** `apps/` *is* the registry — `pithy dev` enumerates `apps/*` (no hand-maintained list) and reads each worker's co-located **`pithy.worker.jsonc`** — a file you own, sitting beside `wrangler.jsonc` (which stays wrangler's) — for its `dev` manifest block: `dev.autostart` (does this worker need to run for the local env to function?), `dev.readySignal` (regex marking "ready" in its output, default `/Ready on https?:\/\//`), an optional `dev.preferredPort`, and an optional `dev.command` (run a non-Worker process — a Vite frontend with no `wrangler.jsonc` — instead of `wrangler dev`). Discovery keys on `pithy.worker.jsonc`, so such a process can join the dev set. It starts exactly the `autostart` workers. Add, remove, or rename a worker with `pithy worker add|remove|rename` and the dev set follows automatically.
- **Runs a front end as part of the set.** A Worker scaffolded by `pithy ui add` (Section 7) does not get a second process. Its `dev.command` replaces `wrangler dev` with Vite, and Vite serves the SPA *and* the Worker on that worker's one pinned port. The command is argv, and the token **`{port}`** in any argument is substituted with that port at spawn time: `["bun", "x", "vite", "dev", "--configLoader", "runner", "--strictPort", "--port", "{port}"]` runs as `bun x vite dev --configLoader runner --strictPort --port 8787`. `{port}` is the only token substituted.
- **Supervises N workers.** Spawns each autostart worker, labels and colorizes their interleaved output, and tees everything to the terminal *and* `logs/dev.log`. A single "ready" banner prints once every started worker matches its `dev.readySignal`.
- **Resolves ports safely.** Each worker's start port is the one pinned in the worktree's port block (Section 6.3), verified — never probed. A port is used only if free on **both** `127.0.0.1` and `::1` (Vite binds IPv6-only, wrangler binds both); if a pinned port is taken, the orchestrator reports a conflict and stops, rather than silently drifting to another port and breaking the sibling workers that were told its address ahead of time.
- **Wires workers to each other over localhost.** Resolved ports are exported as env and the cross-worker URLs are baked in as `*_ORIGIN` dev vars, so workers call each other directly — never relying on wrangler's flaky cross-`wrangler dev` service registry.

### 6.2 Session state and cleanup

- Writes a git-ignored `.dev-state.json` (pid, resolved ports, child pids).
- A re-run stops the previous session first, then **reaps orphaned `workerd`/`wrangler`** processes still holding the default ports (an `lsof` sweep) so a crashed session can't block startup.
- Children are spawned via `setsid` so one `kill(-pgid)` tears down the whole `wrangler → workerd` subtree. Teardown is graceful `SIGTERM`, then `SIGKILL` after a short grace window.

### 6.3 Per-feature ports (run many worktrees at once)

Port collisions are the one thing that stops two feature worktrees running simultaneously. The fix is a **central registry that every feature reads before it assigns** — so a new feature sees what's already taken and can't collide.

- **The registry** is a single git-ignored **`.dev-ports.json`** at the **main repo root** (the parent of `.worktrees/`). A worktree resolves it from anywhere via `git rev-parse --git-common-dir`. It's a map keyed by feature branch, each value the contiguous block that branch owns:

  ```json
  {
    "feature/12-auth":  { "block": 0, "base": 8787, "size": 10 },
    "feature/34-email": { "block": 1, "base": 8797, "size": 10 }
  }
  ```

- **`pithy feature create`** takes a short file lock, reads the registry (seeing every block already in use), assigns the **lowest free, non-overlapping block**, writes its key, and unlocks. One atomic read-modify-write — no two features can pick the same block.
- **`pithy feature destroy`** (and merge-to-`main` cleanup) deletes its key, returning the block to the pool. Add/remove is a single keyed mutation; no per-branch files to orphan.
- **Each worktree** also gets a git-ignored **`.dev.config.json`** — the feature's own dev configuration, written at creation and **fixed for the life of the feature**. It records the reserved block and pins **one port per worker**:

  ```json
  {
    "version": 1,
    "branch": "feature/12-auth",
    "ports": { "index": 0, "base": 8787, "size": 10 },
    "workers": {
      "api": { "port": 8787, "origin": "http://localhost:8787" },
      "web": { "port": 8788, "origin": "http://localhost:8788" }
    }
  }
  ```

  `pithy dev` reads it as its start ports, and every worker's address is known ahead of time, so the workers auto-wire to each other. (Distinct from `.dev-state.json`, the running session's pid/child-pids from Section 6.2.) It is named for the feature's dev config, not for ports alone, so further per-feature dev settings land here without a rename.
- **Ports are assigned at creation, never probed at startup.** Probing when a worker boots is a time-of-check/time-of-use race: two `pithy dev` processes in two worktrees can both observe the same port free and both try to bind it. Pre-assigning every worker its own port from a reserved block removes the race by construction — N features start simultaneously with nothing to negotiate.
- **Per-feature values never go in `.dev.vars`.** That file is one shared secrets file for the whole repo — each worktree's, and each worker's, is a symlink to the main checkout's — so a per-feature value written there would clobber every other feature's. Shared secrets live in `.dev.vars`; per-feature ports live in `.dev.config.json`.
- `pithy dev` still verifies each assigned port is actually free (IPv4 + IPv6) before starting, and **reports a conflict rather than drifting** if something external grabbed one — a worker that quietly moves breaks every sibling that was told its address at creation. Because blocks are disjoint and stable, multiple worktrees run in unison and each feature's workers reach each other on their assigned localhost ports.

> **Why one keyed registry, not a file per branch** (`.dev-ports.<branch>.json`)? A single file shows every allocation in one read, makes add/remove a one-key mutation, and leaves no stale per-branch files to garbage-collect. File-per-branch works but forces a glob-and-read-all to see what's taken.

- **Adding a worker is additive.** Port assignment is *sticky*: a worker that already holds a port keeps it, and only genuinely new workers are assigned, each taking the lowest free port in the block. Discovery is alphabetical, so a purely positional assignment would renumber every later worker the moment someone added one that sorts earlier — moving addresses out from under a running session. A removed worker releases its port back to the block.
- **The registry is self-healing.** `.dev-ports.json` is git-ignored, so it can vanish while the worktrees allocated from it live on. Before allocating, `pithy feature create` reclaims any block still pinned in an existing worktree's `.dev.config.json`, so a lost registry can never hand out a block a live feature is using.

**`pithy feature sync`** — run from the worktree, no arguments, the branch says which feature it is. It makes the local environment ready whatever state it is in, and covers the two everyday cases with one command:

- **You added a worker.** It takes the next free port from the feature's already-reserved block and leaves every existing worker exactly where it was.
- **A colleague pushed the branch and you pulled it.** None of the local state is in git — `.dev.config.json`, the port reservation, and the `.dev.vars` links are all machine-local — so sync creates them on *your* machine, with your own free block, and migrates + seeds your local backend. (This is precisely why ports are never committed: your teammate's block may already be taken on your machine by one of your other worktrees.)

Every step is idempotent, so running it when nothing is missing reports that nothing moved. `--skip-data` reconciles ports and `.dev.vars` without touching the backend.

### 6.3.1 Naming and wiring a feature's live environment

The same branch-first identity that names a feature's D1/KV/R2 resources also names its **Workers**, so a feature environment is fully self-wiring in CI:

```
<project>-f<issue>-<slug>-<worker>     acme-f69-media-cli-api      (Worker script)
<project>-f<issue>-<slug>-<binding>-<kind>   acme-f69-media-cli-db-d1    (D1)
```

`pithy feature provision` writes into each Worker's `wrangler.jsonc env.<env>`:

- **`name`** — the script name that Worker deploys under for the feature, so a preview deploy never overwrites production's.
- **`services[]`** — every `service` binding retargeted at the *feature's* copy of the callee. A capability declares the target Worker on the binding (`{ type: "service", name: "API", service: "api" }`); the CLI resolves `api` to `acme-f69-media-cli-api`. Worker-to-worker RPC therefore stays inside the feature environment instead of reaching production.

**Nothing is stored or committed to make this work.** Every name is derived from the branch, and an already-provisioned resource's id is recovered by looking that name up in Cloudflare — which is exactly what makes `provision` idempotent. On a second push, CI computes the same names, finds the existing D1/KV/R2, rewrites the same wiring, and deploys. There is no id file to merge, so there is nothing to conflict.

A feature environment *is* an environment, so `f<issue>-<slug>` simply occupies the environment slot of the one project-scoped rule every other name follows (`docs/NAMING.md`).

**This is the tightest shape Pithy composes, and it is the shape that caps the project name.** Held to R2's 63 characters, with 7 taken by the fixed literals — `-f`, three more hyphens, and the two-character kind — the four variable segments divide 56 between them: `project + issue + slug + binding = 56`. The issue number is reserved 6 digits, so a 12-character project with a `DB` binding leaves 36 characters of slug at a 6-digit issue, and 40 at a real 2-digit one. A slug over budget is truncated to a head plus a six-hex hash rather than refused — a feature name addresses nothing that outlives the feature, and failing CI over a long branch name would be the worse failure — but a hashed slug tells nobody reading a bucket listing which branch owns it. Keep the part of the branch name after the issue number to roughly 20 characters. `docs/NAMING.md` has the budget worked out per project length.

`<project>` is `pithy.config.ts`'s `name` — required for `pithy feature` naming, with no guessed fallback. `resolveProjectName`'s lenient guesses (an app Worker's `wrangler.jsonc` name, the project directory's basename) are not stable across machines and checkouts, and teardown has no record of a resource beyond its computed name: a wrong guess means `pithy feature destroy` computes names that match nothing, deletes nothing, and exits 0. Set `name` in `pithy.config.ts`; a project without one gets an actionable error the first time a feature command needs it.

### 6.4 Voice

All `pithy dev` output obeys the brand voice (Section 3 / `BRAND.md` §5): labeled lines, deliberate periods, no celebration. The ready banner is information, not confetti.

### 6.5 App-declared Workflows (`pithy worker sync`)

```
pithy worker sync [--worker <name>] [--env <environment>] [--json]
```

A library capability's Workflows are provisioned: `pithy <capability> provision` deploys the host Worker and writes the cross-script binding into the app's `wrangler.jsonc`. A Workflow the **adopter's own app capability** declares had no such path, so its `workflows` array, its `triggers.crons`, and the repetition of both across every environment were written by hand — against `<project>-<env>-<capability>-<job>` and Cloudflare's segment rule, neither of which fails until deploy.

`pithy worker sync` writes them. It reads the Worker's `app` capability, derives each job's name through the same helper the kit uses for a library capability's, and reconciles the result into `wrangler.jsonc`: the top-level stanza and every `env.<name>` the Worker already declares, or just the one `--env` names. It touches no Cloudflare account and runs no deploy.

Three rules govern what it writes:

- **The app's entries are replaced, not merged.** A job renamed or dropped leaves. An entry carrying a `script_name` belongs to a library capability's provisioner and is never touched.
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

What it does not touch is everything outside the worker's own directory: the root `tsconfig.json` references, a vitest config, a CI workflow. Those are yours, they are grep-able, and the command's last line says to look. `pithy doctor` checks the three stamps agree on every run (§5.6), so a hand-rename that misses one fails CI instead of a deploy.

---

## 7. Front ends (`pithy ui`)

`pithy ui` scaffolds a front end into an existing Worker and wires it end to end. The SPA and the API deploy as one unit, on one origin, out of one `apps/<name>/`. This section specifies the command; `docs/UI.md` is the adopter-facing guide to what it writes and how the pieces fit.

### 7.1 Command surface

```
pithy ui add <framework> [--worker <name>] [--auth | --no-auth] [--json]
pithy ui sync [--worker <name>] [--json]
pithy ui list [--json]
```

| Argument / flag | Applies to | Default | Purpose |
|---|---|---|---|
| `<framework>` | `add` | required | The stub to scaffold. `react` is the only stub Pithy ships |
| `--worker <name>` | `add`, `sync` | resolved — see 7.2 | The Worker under `apps/` to scaffold into, or to re-derive |
| `--auth` / `--no-auth` | `add` | see 7.3 | Scaffold the sign-in screens, or leave them out |
| `--json` | all three | `false` | One line of machine-readable output. Implies non-interactive: `pithy ui` never prompts when `--json` is set |

**There are no provider flags.** No `--google`, no `--github`, no `--turnstile`. Which social providers exist, and whether a humanity check gates sign-in, is already declared in that Worker's `pithy.config.ts`. A flag would be a second source of truth, frozen at scaffold time, that drifts the moment someone enables a provider in config. The scaffolded screens read the composed config at runtime instead (see `docs/UI.md`), so enabling a provider stays a one-line config edit and a redeploy — no CLI run, no file to regenerate, nothing to keep in step.

### 7.2 Resolving the Worker

`ui add` and `ui sync` wire exactly one Worker, so they take `--worker <name>` and follow the same rule as `add` and `remove` (Section 1.1): with a single Worker under `apps/` the flag is optional and that Worker is used; with several, the CLI prompts at a terminal and **fails with an actionable error under `--json`** rather than guessing. Scaffolding a front end into the wrong Worker would put an `assets` stanza and an asset-routing allowlist on a script that serves no browser.

`ui list` takes no `--worker`: it reports the framework stubs `ui add` can scaffold, not the Workers that already carry one. For the per-Worker view — which Workers exist, which autostart, which port each holds — use `pithy worker list`.

### 7.3 The auth screens

`pithy ui add` asks once whether to scaffold the sign-in screens:

```
Scaffold the sign-in screens? [Y/n]
```

- The default is **yes when the target Worker composes the `auth` capability**. The prompt is skipped entirely when it does not — there is nothing for a sign-in screen to call.
- `--auth` and `--no-auth` answer it non-interactively. Under `--json` the resolved default applies unless one of them is passed.
- With auth on, the stub adds `src/routes/pithy/` — the magic-link, OTP, and callback screens — and the router's route guard. With auth off, everything else is still scaffolded; only Pithy's screens are omitted.

Passing `--auth` to a Worker that does not compose auth is an error, not a warning (7.8).

### 7.4 What it writes

Every file is written **only if it does not already exist**. `pithy ui add` never overwrites, never merges, never reformats. A file already on disk is left byte-for-byte alone and reported as kept. That is the whole ownership model: Pithy authors a file once, and from that moment it is yours.

| Path (under `apps/<worker>/`) | Written when | What it is |
|---|---|---|
| `index.html` | always | The Vite entry document |
| `vite.config.ts` | always | `cloudflare()` + `react()` + `pithy()` |
| `tsconfig.client.json` | always | The client program — jsx + DOM, covering `src/**/*.tsx` and `client-env.d.ts` |
| `tsconfig.node.json` | always | The config program — `types: ["node"]`, covering `vite.config.ts` |
| `client-env.d.ts` | always | Ambient declarations for the `virtual:pithy/*` modules |
| `src/client.tsx` | always | The SPA entry |
| `src/router.tsx` | always | The two-glob router and its route guard |
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

### 7.5 What it wires

Three files are edited.

**`wrangler.jsonc` — the `assets` stanza.** `not_found_handling` is `"single-page-application"`, and `run_worker_first` is an **explicit allowlist derived from that Worker's composed route table** — never `true`, never a guessed prefix like `/api/*`. Pithy's routes sit at capability base paths (`/auth`, `/leaderboard`, `/payments`, `/storage`, `/media`, …) plus `/health`; nothing lives under `/api`, and an allowlist that assumes otherwise hands `GET /health` the SPA shell. Two derivation rules:

- Every entry is emitted in **two forms**, the bare path and its `/*` glob, because `"/auth/*"` does not match a bare `"/auth"`.
- Never a bare-prefix glob. `"/media*"` also captures `/mediafoo`; the pair `"/media"` + `"/media/*"` captures the route table exactly.

`assets.directory` is **not** written. Under the Vite plugin the directory is the plugin's to set — it overwrites the key silently rather than erroring, so a value there would be a lie in the adopter's own config.

The array form of `run_worker_first` also turns off Cloudflare's automatic `Sec-Fetch-Mode: navigate` detection, which is the point: `not_found_handling` then applies only to requests no worker-first pattern matched, so an API route can never be answered with the SPA shell.

**`pithy.worker.jsonc` — the `dev` and `ui` blocks.**

```jsonc
{
  "dev": { "autostart": true, "readySignal": "ready in \\d+", "command": ["bun", "x", "vite", "dev", "--configLoader", "runner", "--strictPort", "--port", "{port}"] },
  "ui": { "stub": "react", "build": ["vite", "build", "--configLoader", "runner"] }
}
```

`dev.command` is what joins the front end to the dev set (Section 6.1), `{port}` and all. `--strictPort` is not optional: without it Vite silently increments off a busy port, and a worker that quietly moves breaks every sibling that was told its address at creation. `ui.stub` records which stub was scaffolded — it is what makes a second `ui add` on the same Worker an error, and what tells `ui add --auth` it is backfilling a scaffold rather than starting one. `ui.build` is argv run through the adopter's package manager before `wrangler deploy`, so a UI-bearing Worker never ships a stale client. `pithy deploy --env <name>` sets `ENVIRONMENT` for that build, which is what makes a capability's per-environment client values — a Turnstile sitekey, say — resolve for the environment being shipped rather than for `dev`. Both commands carry `--configLoader runner`, and that is load-bearing rather than a preference: Vite's default config loader bundles `vite.config.ts` and leaves `@pithy-sh/vite` external, which asks Node to import raw TypeScript with extensionless relative imports — Node cannot resolve those, and refuses to strip types under `node_modules` at all. The runner loads the config through Vite's own resolver, where both are ordinary.

**`package.json` — the client dependencies and the scripts that run them.** React, the Vite plugins, and `@pithy-sh/vite`, at the versions listed in `docs/UI.md`. Written at scaffold; `pithy ui` never revisits them. A `@pithy-sh/*` package a linked checkout already provides is left out of `devDependencies` — it resolves without a range, and a range naming a version the registry does not have would break the next install. `devDependencies` in the `--json` result names only what was written, so that run omits it there too.

### 7.6 `pithy ui sync`

`run_worker_first` is derived from the route table, and the route table changes when the Worker's capabilities do. `pithy ui sync` re-derives it and rewrites that one key. Run it after `pithy add <capability>` or `pithy remove <capability>` on a Worker that carries a UI — otherwise the new capability's routes are shadowed by the SPA shell, and a removed one's stay allowlisted.

`sync` touches nothing else. No file is created, no dependency moves, no scaffolded screen is regenerated. It is idempotent: a run with nothing to change reports that nothing moved.

### 7.7 `--json`

One line, one object, one shape per subcommand. The `command` field is the subcommand's dotted name, matching `worker.add` and `feature.create` rather than the space-separated form the resource commands use.

```
$ pithy ui add react --worker api --json
{"command":"ui.add","worker":"pithy-app-api","framework":"react","auth":true,"created":["client-env.d.ts","index.html","src/client.tsx","src/pithy-config.tsx","src/router.tsx","src/routes/app/home.tsx","src/routes/pithy/callback.tsx","src/routes/pithy/otp.tsx","src/routes/pithy/sign-in.tsx","src/session.tsx","src/styles.css","src/turnstile.tsx","tsconfig.client.json","tsconfig.node.json","vite.config.ts"],"skipped":[],"runWorkerFirst":["/auth","/auth/*","/health","/health/*"],"packageManager":"bun","dependencies":["react","react-dom"],"devDependencies":["@cloudflare/vite-plugin","@pithy-sh/vite","@types/react","@types/react-dom","@vitejs/plugin-react","vite"],"scripts":["dev","build","preview"]}
```

`worker` is the Worker's name as `wrangler.jsonc` gives it, not the `apps/` directory. `created` and `skipped` are worker-relative and sorted; together they are every file the template declares, so a backfilling run reports the untouched ones rather than staying silent about them. `dependencies`, `devDependencies` and `scripts` name only what this run added.

```
$ pithy ui sync --worker api --json
{"command":"ui.sync","worker":"pithy-app-api","before":["/auth","/auth/*","/health","/health/*"],"after":["/auth","/auth/*","/health","/health/*","/leaderboard","/leaderboard/*"],"changed":true,"notFoundHandling":"single-page-application"}
```

`before` and `after` are the allowlist either side of the run, so a CI job can log the delta without recomputing it. `changed` covers everything the call can have moved — the allowlist, or a `not_found_handling` it had to write because the stanza carried none. `notFoundHandling` is reported because SPA routing depends on it and `sync` does not overwrite a value the adopter chose.

```
$ pithy ui list --json
{"command":"ui.list","stubs":[{"id":"react","description":"React 19 SPA on Vite, served by the worker as static assets"}]}
```

### 7.8 Errors

Each one is a `PithyError` — the problem, then the action (Section 3.3).

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

---

## 8. Data seeding (`pithy seed`)

`pithy seed` loads test data into an environment from the same Zod schemas and codecs that define your tables and KV stores — no separate fixture format, no hand-written SQL. Fixtures are authored with `defineSeed` (the peer of `defineCapability`) and composed library-before-app, exactly like migrations. The full authoring model — `defineSeed`, media `once`/`always`, the standard asset-metadata convention, the env-safety layers — is documented in `docs/SEED.md`; this section covers the command itself.

### 8.1 Flags

| Flag | Default | Purpose |
|---|---|---|
| `--env <name>` | `dev` | The environment to seed. `dev` runs locally against Miniflare; anything else runs against the live D1/KV/R2/Images/Stream for that env |
| `--json` | `false` | Machine-readable output — the full write plan or run report as one JSON line. Implies non-interactive: `pithy seed` never prompts when `--json` is set |
| `--dry-run` | `false` | Compute and print the write plan without touching any backend. Reads media sidecars to report `upload`/`skip`/`reupload` accurately; mints nothing |
| `--redo` | `false` | **DESTRUCTIVE.** Drop every table and recreate the schema before seeding — all data is lost. See 8.5 |
| `--confirm-reset` | — | Unlock a non-`dev` `--redo`: the exact phrase `yes, i really want to reset <env>` |
| `--yes` | `false` | Confirm a non-`dev` environment. Required for `staging` and `prod`; `dev` never needs it |
| `--confirm-production <phrase>` | — | The non-interactive unlock for `prod` — see 8.3 |

### 8.2 Output

A normal run reports one line per seed set, then `Done.`. Every line is prefixed with the Worker that ran it — the run fans out over `apps/*`, so a fan-out over several Workers reads as one list rather than several interleaved ones. Each set is named by its composed key, `NNNN_<capability>_<name>` (see `docs/SEED.md`):

```
$ pithy seed --env dev
api  0100_auth_test_users: 3 rows, 1 entry.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

A set with nothing to write for the current shape still gets a line, so a quiet run is never mistaken for a skipped one:

```
$ pithy seed --env dev
api  0300_media_avatar: nothing to seed.
Done.
```

A set present in the registry but not allowed for the target environment is reported above the sets that ran, never silently dropped:

```
$ pithy seed --env dev
api  skipped 0210_leaderboard_prod_smoke: not allowed in dev.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

`--dry-run` prints the same per-set shape and adds a plain reminder before `Done.`:

```
$ pithy seed --env staging --dry-run
api  0200_leaderboard_demo_board: 12 rows.
Dry run. Nothing written.
Done.
```

`--json` emits the full plan or report as a single line — the same shape either way, one entry per Worker, with `dryRun` telling you which:

```
$ pithy seed --env dev --dry-run --json
{"command":"seed","env":"dev","dryRun":true,"workers":[{"worker":"api","sets":[{"name":"0200_leaderboard_demo_board","d1":[{"database":"app","table":"boardEntries","rows":12}],"kv":[],"r2":[],"media":[]}],"skippedByEnv":[],"shared":[]}]}
```

### 8.3 The production exception

Every other flag in Pithy follows the same rule everywhere: `--json` means non-interactive, full stop. `pithy seed --env prod` is the one place a flag additionally gates *content*, not just interactivity — because seeding production is rare and should stay rare.

- `dev` never asks for anything.
- `staging` (and any other non-`dev`, non-production environment) needs `--yes`.
- `prod` needs `--yes` **and** the exact phrase `yes, i really want to seed production`, matched case-insensitively after trimming. Interactively, `pithy seed` prompts for it with `@clack/prompts`. Non-interactively (`--json`, CI, no TTY), there is no prompt — pass it directly:

  ```
  pithy seed --env prod --yes --confirm-production "yes, i really want to seed production"
  ```

  Get the phrase wrong, or omit it non-interactively, and the run is refused before anything opens:

  ```
  $ pithy seed --env prod --yes --json
  The production confirmation phrase did not match.
  Pass --confirm-production "yes, i really want to seed production" to seed production.
  ```

The flag and the phrase keep the word `production` deliberately. The **environment** is named `prod`, and `--env production` is refused — but a confirmation phrase is read by a human about to overwrite live data, and `yes, i really want to seed prod` is a sentence you can type without meaning it.

Underneath both gates is a third, structural one that no flag can bypass: a seed set is only ever composed for `prod` if it lists `prod` in its own `environments` array. See `docs/SEED.md` for the full layered model.

### 8.4 Idempotency

Every `pithy seed` run is safe to repeat. D1 rows insert with `INSERT OR IGNORE`; KV entries `put` by key; a `once` media asset uploads on its first run only and skips on every run after. Re-running `pithy seed` against an environment that already has the fixtures loaded writes nothing new and changes nothing existing.

This is also why editing a fixture's values and re-running `pithy seed` does nothing: the row already exists, so it is ignored, unchanged. See 8.5.

### 8.5 Resetting data (`--redo`)

`--redo` is for the moment you edited a fixture's values and want them to actually land. Idempotency (8.4) means a plain re-seed never refreshes existing rows, so `--redo` exists to force it — but it is **not** a per-row refresh. It is a full schema reset:

1. Roll every migration back — every `down`, not just the latest, in reverse order.
2. Reapply every migration's `up`, recreating the schema empty.
3. Seed as normal.

Because every table the migration registry owns comes back empty, step 3's ordinary non-destructive writes just work — there is nothing left to special-case. There is also nothing left of what was there before: **`--redo` destroys every row in every table the registry owns, not just the rows a fixture wrote.** Data you inserted by hand, in a seeded table, does not survive. This is the sharp edge — reach for `--redo` only when a clean rebuild is actually what you want.

A real reset opens with the banner that names what it just did, then a line per database:

```
$ pithy seed --env dev --redo
DESTRUCTIVE. Every table in dev was dropped and recreated.
Reset app (DB): 1 migration rolled back and reapplied.
api  0200_leaderboard_demo_board: 12 rows.
Done.
```

`--redo --dry-run` reports what would be reset and written, and touches nothing — no banner, because nothing was dropped:

```
$ pithy seed --env staging --redo --dry-run
Would reset app (DB): 1 migration.
api  0200_leaderboard_demo_board: 12 rows.
Dry run. Nothing written.
Done.
```

**`--redo` carries its own, stricter gate — it is not the seed gate.** `--yes` means "yes, this is not dev"; it was designed to authorize *writing* seed rows, which is additive and harmless. A reset drops every table first. Letting one flag authorize both would mean a script — or a hand — that knew only to pass `--yes` could destroy an environment's entire dataset. So:

| Environment | Plain seed | `--redo` |
|---|---|---|
| `dev` | free | free — a local Miniflare store is what reset is for |
| `staging`, a feature env, anything non-`dev` | `--yes` | **the exact phrase** `yes, i really want to reset <env>` |
| `prod` (+ any name in `seed.productionEnvironments`) | `--yes` + the seed confirm phrase | the reset phrase, and it is refused headlessly without it |

The phrase **names its environment**, so a phrase authorizing a `staging` reset cannot be pasted into a command targeting another one. Pass it as `--confirm-reset "yes, i really want to reset staging"`; interactively, the prompt states plainly that all data will be lost before asking. Automation is preserved — CI passes the flag explicitly — a reset simply cannot happen by accident.

A non-`dev` reset is **audited**: a `seed/schema_reset` event is recorded at `critical` severity naming the environment and the databases involved. The outcome is always truthful: recorded as `success` once the reset actually completes, or as `failure` — and the command still fails — if it dies partway. A `dev` reset records nothing — auditing covers actions that reach a **remote** system (from a developer's machine, from CI, or in production); a `dev` run only touches the local Miniflare store and changes nothing shared. Auditing is also a no-op when the project does not compose `@pithy-sh/audit`.

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
